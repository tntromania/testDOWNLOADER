const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; // Verifică dacă calea e corectă (ex: 'yt-dlp')
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- 1. CURĂȚARE TEXT (VTT to Plain Text) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        // Eliminăm metadatele VTT și tag-urile de timp
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || 
            line.startsWith('Kind:') || line.startsWith('Language:')) return;
        
        line = line.replace(/<[^>]*>/g, ''); // Eliminăm tag-uri de tip <c>
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE GPT-4o-mini CU LOGS ---
async function translateWithAI(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    console.log("\n--- [GPT LOG] Încep traducerea textului ---");
    console.log(`[GPT LOG] Text original (fragment): ${text.substring(0, 200)}...`);

    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul în limba Română, natural și fluent." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });

            const result = response.data.choices[0].message.content;
            console.log(`[GPT LOG] Traducere finalizată cu succes.`);
            console.log(`[GPT LOG] Rezultat (fragment): ${result.substring(0, 200)}...`);
            return result;
        } catch (e) { 
            console.error("[GPT LOG] Eroare OpenAI:", e.message);
        }
    }
    
    // Fallback Google Translate
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { return "Traducere indisponibilă."; }
}

// --- 3. EXTRAGERE TRANSCRIPT (Direct URL Method) ---
async function getOriginalTranscript(url) {
    return new Promise((resolve) => {
        console.log(`[DEBUG] Extragere metadate pentru transcript: ${url}`);
        
        // Cerem de la yt-dlp direct JSON-ul metadatelor fără să descărcăm nimic
        const args = ['--dump-json', '--skip-download', url];
        if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

        const proc = spawn(YTDLP_PATH, args);
        let output = '';

        proc.stdout.on('data', (data) => output += data);
        proc.on('close', async () => {
            try {
                const json = JSON.parse(output);
                // Căutăm în subtitrările automate (cele oferite gratis de YouTube)
                const captions = json.automatic_captions;
                
                // Încercăm să găsim engleza (en) în orice format (vtt e cel mai bun)
                const enCaptions = captions['en'] || captions['en-US'] || captions['en-orig'];
                
                if (enCaptions) {
                    const vttUrl = enCaptions.find(f => f.ext === 'vtt')?.url || enCaptions[0].url;
                    console.log(`[DEBUG] URL Subtitrare găsit: ${vttUrl.substring(0, 50)}...`);
                    
                    // Descărcăm conținutul VTT direct cu axios
                    const vttResponse = await axios.get(vttUrl);
                    const cleanedText = cleanVttText(vttResponse.data);
                    resolve(cleanedText);
                } else {
                    console.log("[DEBUG] Nu am găsit subtitrări în engleză.");
                    resolve(null);
                }
            } catch (e) {
                console.error("[DEBUG] Eroare la parsare JSON/descărcare VTT:", e.message);
                resolve(null);
            }
        });
    });
}

// --- 4. METADATA TITLU ---
async function getYtMetadata(url) {
    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--skip-download', url]);
        let buf = '';
        proc.stdout.on('data', d => buf += d);
        proc.on('close', () => {
            try { 
                const data = JSON.parse(buf);
                resolve({ title: data.title || "Video" }); 
            } catch (e) { resolve({ title: "Video" }); }
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        const metadata = await getYtMetadata(videoUrl);
        const originalText = await getOriginalTranscript(videoUrl);
        
        let transcriptData = { original: null, translated: null };
        if (originalText && originalText.length > 10) {
            const translatedText = await translateWithAI(originalText);
            transcriptData = {
                original: originalText.substring(0, 3000),
                translated: translatedText
            };
        }

        const formats = [
            { quality: '720p', format: 'mp4', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video` },
            { quality: '192kbps', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                formats: formats,
                transcript: transcriptData
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.get('/api/stream', (req, res) => {
    const isAudio = req.query.type === 'audio';
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '--no-warnings', '-f', isAudio ? 'bestaudio' : 'best', req.query.url];
    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server pornit pe ${PORT}`));