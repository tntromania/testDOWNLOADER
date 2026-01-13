const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003;

// --- CONFIGURARE ---
app.use(cors());
app.use(express.json());
// Această linie este critică pentru a vedea interfața (index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Cheia se ia din variabilele de mediu setate în Coolify
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = 'yt-dlp'; 

// --- 1. DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- 2. CURĂȚARE TEXT (VTT) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        if (!line || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('WEBVTT')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 3. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) {
        return text;
    }
}

// --- 4. TRADUCERE GPT CU STREAMING ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 3500); // Limităm pentru siguranță

    console.log("\n🤖 GPT-4o-mini începe traducerea...");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural. Nu adăuga alte comentarii." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3,
            stream: true
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        let fullTranslation = "";

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                for (const line of lines) {
                    const message = line.replace(/^data: /, '');
                    if (message === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(message);
                        const content = parsed.choices[0].delta.content;
                        if (content) {
                            process.stdout.write(content); 
                            fullTranslation += content;
                        }
                    } catch (e) {}
                }
            });

            response.data.on('end', () => {
                console.log("\n✅ Traducere GPT finalizată.");
                resolve(fullTranslation);
            });

            response.data.on('error', (err) => reject(err));
        });

    } catch (error) {
        console.warn("⚠️ Eroare OpenAI:", error.message);
        return await translateWithGoogle(text);
    }
}

// --- 5. LOGICA EXTRAGERE TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const subProcess = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        subProcess.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                const content = fs.readFileSync(foundFile, 'utf8');
                const clean = cleanVttText(content);
                try { fs.unlinkSync(foundFile); } catch(e){}
                resolve(clean);
            } else {
                resolve(null);
            }
        });
    });
}

// --- 6. METADATE VIDEO ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const metaProcess = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        metaProcess.stdout.on('data', d => buffer += d);
        metaProcess.on('close', () => {
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                resolve({ title: "Video", duration_string: "0:00", description: "" }); 
            }
        });
    });
}

// --- 7. ENDPOINTS API ---

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`[${platform.toUpperCase()}] Cerere: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            if (!originalText) originalText = metadata.description || "Niciun text găsit.";
            
            const translatedText = await translateWithGPT(originalText);
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        }

        const formats = [
            { quality: 'Audio Only (MP3)', url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'Video HD (MP4)', url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: transcriptData
            }
        });
    } catch (error) {
        console.error("Eroare generală:", error);
        res.status(500).json({ error: 'Eroare internă la procesare.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const filename = type === 'audio' ? 'audio.mp3' : 'video.mp4';
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    const args = [
        '-o', '-', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '-f', type === 'audio' ? 'bestaudio' : 'best', 
        url
    ];
    
    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    
    streamProcess.stderr.on('data', (data) => {
        // Logăm erorile de streaming doar dacă e nevoie
    });
});

// Ruta de fallback pentru a trimite index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Pornire server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Downloader Pro activ!
    Domeniu: downloader.creatorsmart.ro
    Port local: ${PORT}
    ----------------------------------
    `);
});