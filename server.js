const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003;

// --- CONFIGURARE MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// SERVIRE FIȘIERE STATICE: Această linie este vitală pentru a vedea index.html
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
        console.error("Eroare Google Translate:", err.message);
        return text;
    }
}

// --- 4. TRADUCERE GPT ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 3500);

    console.log("\n🤖 GPT-4o-mini începe traducerea...");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural. Nu adăuga comentarii meta." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
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
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        subProcess.on('close', () => {
            const file = `${outputTemplate}.en.vtt`;
            if (fs.existsSync(file)) {
                const content = fs.readFileSync(file, 'utf8');
                const clean = cleanVttText(content);
                try { fs.unlinkSync(file); } catch(e){}
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
        const metaProcess = spawn(YTDLP_PATH, ['--dump-json', '--no-check-certificates', url]);
        let buffer = '';
        metaProcess.stdout.on('data', d => buffer += d);
        metaProcess.on('close', () => {
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                resolve({ title: "Video", duration_string: "N/A", description: "" }); 
            }
        });
    });
}

// --- 7. ENDPOINTS API ---

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`[${platform.toUpperCase()}] Cerere info: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            if (!originalText) originalText = metadata.description || "";
            
            const translatedText = await translateWithGPT(originalText);
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        }

        const displayDuration = metadata.duration_string || (metadata.duration ? `${Math.floor(metadata.duration / 60)}:${metadata.duration % 60}` : "N/A");

        const formats = [
            { quality: 'MP3', url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'MP4', url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title || "Video",
                duration: displayDuration,
                formats: formats,
                transcript: transcriptData
            }
        });
    } catch (error) {
        console.error("Eroare API Download:", error);
        res.status(500).json({ error: 'Eroare la obținerea informațiilor.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    const filename = isAudio ? 'audio.mp3' : 'video.mp4';
    
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    const args = [
        '-o', '-', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '-f', isAudio ? 'bestaudio' : 'best', 
        url
    ];
    
    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);

    streamProcess.on('error', (err) => {
        console.error("Stream error:", err);
    });
});

// --- 8. RUTA FALLBACK ---
// Trimite index.html pentru orice cerere care nu este de API (ex: root-ul '/')
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 9. PORNIRE SERVER ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Downloader Pro activ!
    Domeniu: downloader.creatorsmart.ro
    Port: ${PORT}
    ----------------------------------
    `);
});