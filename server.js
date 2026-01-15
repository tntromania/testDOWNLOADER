const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();

// --- CONFIGURARE STRICTĂ ---
const PORT = 3003; 
const PUBLIC_DOMAIN = 'https://downloader.creatorsmart.ro'; // Aici e cheia

app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = path.join(__dirname, 'yt-dlp.exe');

// --- RUTA DE HEALTH CHECK (Să nu mai ai eroare la access simplu) ---
app.get('/', (req, res) => {
    res.send('API Active - CreatorsSmart Downloader');
});

// --- DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- CURĂȚARE TEXT ---
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

// --- TRADUCERE GPT ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 3000);
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        return `(Eroare Traducere): ${text}`; 
    }
}

// --- EXTRACTIE TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--skip-download', '--write-sub', '--write-auto-sub', '--sub-lang', 'en', '--convert-subs', 'vtt', '--output', outputTemplate, '--no-check-certificates', url]);
        process.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));
            if (foundFile) {
                const content = fs.readFileSync(foundFile, 'utf8');
                const clean = cleanVttText(content);
                try { fs.unlinkSync(foundFile); } catch(e){}
                resolve(clean);
            } else { resolve(null); }
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

// --- ENDPOINT DOWNLOAD ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`Processing: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        const platform = detectPlatform(videoUrl);
        let transcriptData = null;

        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            if (!originalText) originalText = metadata.description || "Niciun text găsit.";
            
            // Traducere simplă (fără stream complex ca să nu blocheze)
            const translatedText = await translateWithGPT(originalText);
            
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        }

        // --- GENERARE LINK-URI CU DOMENIUL TĂU ---
        const formats = [
            { 
                quality: 'Video HD (MP4)', 
                url: `${PUBLIC_DOMAIN}/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` 
            },
            { 
                quality: 'Audio Only (MP3)', 
                url: `${PUBLIC_DOMAIN}/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` 
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
        console.error(error);
        res.status(500).json({ error: 'Eroare server.' });
    }
});

// --- ENDPOINT STREAM ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = [
        '-o', '-', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '-f', type === 'audio' ? 'bestaudio' : 'best', 
        url
    ];
    
    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

// --- SERVER START ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Public Links will use: ${PUBLIC_DOMAIN}`);
});