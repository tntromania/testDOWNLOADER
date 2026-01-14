const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // Asigură-te că ai dat npm install axios
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CHEIA TA OPENAI ---
// Am pus cheia ta direct aici ca să fii sigur că merge 1:1
const OPENAI_API_KEY = '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';

// --- CONFIG LINUX ---
const YTDLP_PATH = 'yt-dlp';

// --- DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- 1. CURĂȚARE TEXT ---
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

// --- 2. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) {
        return text; // Dacă și asta pică, returnăm originalul
    }
}

// --- 3. TRADUCERE GPT (LOGICA TA) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    // Limităm la 3000 caractere pentru a nu consuma tokeni inutili dacă e video lung
    const textToTranslate = text.substring(0, 3000);

    console.log("🤖 GPT-4o-mini începe traducerea...");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural." },
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

        // Procesăm stream-ul manual (exact cum aveai tu)
        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                for (const line of lines) {
                    const message = line.replace(/^data: /, '');
                    if (message === '[DONE]') return;
                    try {
                        const parsed = JSON.parse(message);
                        const content = parsed.choices[0].delta.content;
                        if (content) fullTranslation += content;
                    } catch (error) {}
                }
            });
            response.data.on('end', () => {
                console.log("✅ Traducere GPT finalizată.");
                resolve(fullTranslation);
            });
            response.data.on('error', (err) => reject(err));
        });

    } catch (error) {
        console.warn("⚠️ Eroare OpenAI:", error.message);
        return await translateWithGoogle(text);
    }
}

// --- 4. HELPERS DOWNLOAD ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        process.on('close', () => {
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

function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => {
            try { resolve(JSON.parse(buffer)); } catch (e) { resolve({ title: "Video", description: "" }); }
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`\n[${platform.toUpperCase()}] Procesez: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        if (platform === 'youtube') {
            console.log("📝 Extrag transcript...");
            let originalText = await getOriginalTranscript(videoUrl);

            if (!originalText) {
                originalText = metadata.description || "Niciun text găsit.";
            }

            const translatedText = await translateWithGPT(originalText);
            
            transcriptData = {
                original: originalText,
                translated: translatedText
            };
        }

        // --- CHEIA SUCCESULUI PENTRU HTML-UL TĂU NOU ---
        // Aici construim array-ul exact cum îl așteaptă JS-ul din frontend
        const formats = [
            { 
                quality: 'MP4',      // Doar etichetă vizuală
                format: 'mp4',       // CRITIC: Frontend-ul caută asta
                hasVideo: true,      // CRITIC: Frontend-ul caută asta
                hasAudio: true,
                url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` 
            },
            { 
                quality: 'MP3', 
                format: 'mp3',       // CRITIC: Frontend-ul caută asta
                hasVideo: false,
                hasAudio: true,
                url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` 
            }
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
        console.error("Eroare server:", error);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

// --- STREAMING ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = ['-o', '-', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

// Servește index.html-ul tău NOU
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server GPT-PRO pornit pe ${PORT}`);
});