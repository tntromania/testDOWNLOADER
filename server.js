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
app.use(express.static(path.join(__dirname, 'public')));

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

// --- 2. CURĂȚARE TEXT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('WEBVTT') || line.startsWith('NOTE')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 3. TRADUCERI ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) { return text; }
}

async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 4000);
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul natural." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        return await translateWithGoogle(text);
    }
}

// --- 4. EXTRAGERE TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputBase = path.join(__dirname, `temp_${uniqueId}`);
    return new Promise((resolve) => {
        const subProcess = spawn(YTDLP_PATH, [
            '--skip-download', '--write-auto-sub', '--write-sub', '--convert-subs', 'vtt',
            '--output', outputBase, '--no-check-certificates', '--no-warnings', 
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
            url
        ]);
        subProcess.on('close', () => {
            const files = fs.readdirSync(__dirname);
            const vttFile = files.find(f => f.startsWith(`temp_${uniqueId}`) && f.endsWith('.vtt'));
            if (vttFile) {
                const content = fs.readFileSync(path.join(__dirname, vttFile), 'utf8');
                fs.unlinkSync(path.join(__dirname, vttFile));
                resolve(cleanVttText(content));
            } else { resolve(null); }
        });
    });
}

// --- 5. METADATE (AICI ERA PROBLEMA) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        // MODIFICARE: Adăugat User-Agent pentru a păcăli YouTube că suntem browser, nu bot
        const args = [
            '--dump-json',
            '--no-check-certificates',
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
            url
        ];

        const metaProcess = spawn(YTDLP_PATH, args);
        let buffer = '';
        let errorBuffer = '';

        metaProcess.stdout.on('data', d => buffer += d);
        metaProcess.stderr.on('data', d => errorBuffer += d); // Capturăm eroarea reală

        metaProcess.on('close', (code) => {
            if (code !== 0) {
                console.error("❌ EROARE YT-DLP (Metadata):", errorBuffer.toString());
            }
            try { 
                const data = JSON.parse(buffer);
                resolve(data); 
            } catch (e) { 
                console.log("⚠️ Nu s-a putut citi JSON-ul. Output brut:", buffer.toString());
                resolve({ title: "Titlu Indisponibil (Verifică Logs)", duration: 0 }); 
            }
        });
    });
}

// --- 6. ENDPOINTS ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });
    const platform = detectPlatform(videoUrl);
    
    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            if (!originalText && metadata.description) originalText = metadata.description;
            if (originalText) {
                const translatedText = await translateWithGPT(originalText);
                transcriptData = { original: originalText, translated: translatedText };
            }
        }

        // Calcul durată
        let durationStr = "N/A";
        if (metadata.duration) {
            const m = Math.floor(metadata.duration / 60);
            const s = metadata.duration % 60;
            durationStr = `${m}:${s.toString().padStart(2, '0')}`;
        } else if (metadata.duration_string) {
            durationStr = metadata.duration_string;
        }

        const formats = [
            { quality: 'MP3', url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'MP4', url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title || "Video Fără Titlu",
                duration: durationStr,
                formats: formats,
                transcript: transcriptData
            }
        });
    } catch (error) {
        console.error("Eroare server:", error);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = [
        '-o', '-', '--no-check-certificates', '--no-warnings', '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
        '-f', isAudio ? 'bestaudio' : 'best', 
        url
    ];
    
    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server PRO activ pe ${PORT}`));