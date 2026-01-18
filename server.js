const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp'; // Verifică calea pe serverul tău
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ⚡ CACHE ÎN MEMORIE
const memoryCache = new Map();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Helper: Verificăm dacă e YouTube
function isYoutubeUrl(url) {
    return /(youtube\.com|youtu\.be)/i.test(url);
}

// Argumente "Lightweight"
// Argumente "Lightweight" & Anti-Ban
function getFastArgs() {
    const args = [
        '--no-warnings', 
        '--no-check-certificates', 
        '--referer', 'https://www.youtube.com/',
        '--compat-options', 'no-youtube-unavailable-videos',
        '--no-playlist',
        
        // 🔥 MODIFICARE: Folosim 'android' în loc de 'ios'. 
        // Android e mai stabil pentru Shorts și nu dă eroarea "Format not available" așa des.
        '--extractor-args', 'youtube:player_client=android',
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    
    return args;
}

// Curățare VTT
function cleanVttText(vttContent) {
    const lines = vttContent.split('\n');
    const uniqueLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line)) return;
        const cleanLine = line.replace(/<[^>]*>/g, '').trim();
        if (cleanLine) uniqueLines.add(cleanLine);
    });
    return Array.from(uniqueLines).join(' ');
}

// Extragere Transcript (Doar pentru YouTube)
async function getTranscriptWithYtDlp(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/transcript_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const args = [
            ...getFastArgs(),
            '--skip-download', 
            '--write-subs', 
            '--write-auto-subs',
            '--sub-lang', 'en,ro,.*', 
            '--sub-format', 'vtt',
            '--output', outputBase,
            url
        ];

        const process = spawn(YTDLP_PATH, args);
        
        process.on('close', () => {
            const dir = '/tmp';
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const files = fs.readdirSync(dir);
                const transcriptFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));
                
                if (transcriptFile) {
                    const fullPath = path.join(dir, transcriptFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    fs.unlinkSync(fullPath); 
                    resolve(cleanVttText(content));
                } else {
                    resolve(null);
                }
            } catch (err) { resolve(null); }
        });
    });
}

// Metadata RAPID
async function getYtMetadata(url) {
    return new Promise(resolve => {
        const args = [
            ...getFastArgs(),
            '--print', '%(title)s|%(duration_string)s', 
            url
        ];
        
        const p = spawn(YTDLP_PATH, args);
        let data = '';
        p.stdout.on('data', d => data += d);
        
        p.on('close', () => {
            const parts = data.trim().split('|');
            if (parts.length >= 2) {
                resolve({ title: parts[0], duration: parts[1] });
            } else {
                resolve({ title: "Video Download", duration: "--:--" });
            }
        });
    });
}

// Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (No API Key).";
    if (!text || text.length < 5) return "Text prea scurt pentru rezumat/traducere.";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Traducere directă în română. Fără explicații." },
                { role: "user", content: text }
            ],
            max_tokens: 1000,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        return "Eroare traducere GPT.";
    }
}

// 🚀 ENDPOINT PRINCIPAL (MODIFICAT PENTRU NON-YOUTUBE INSTANT)
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    // 1. VERIFICĂ CACHE-UL
    if (memoryCache.has(videoUrl)) {
        console.log('⚡ Serving from CACHE (Instant)!');
        return res.json(memoryCache.get(videoUrl));
    }

    console.log('\n🎬 Processing:', videoUrl);
    const startTime = Date.now();
    const isYt = isYoutubeUrl(videoUrl); // Verificăm sursa

    try {
        let metadataPromise = getYtMetadata(videoUrl);
        let transcriptPromise;

        // 🔥 LOGICA NOUĂ: Doar YouTube primește transcript
        if (isYt) {
            console.log('🔹 YouTube detectat: Se extrage transcript...');
            transcriptPromise = getTranscriptWithYtDlp(videoUrl);
        } else {
            console.log('🔹 Altă platformă: Mod INSTANT (Fără transcript)...');
            transcriptPromise = Promise.resolve(null); // Returnăm imediat null
        }

        // 2. PARALELIZARE (Chiar și dacă transcript e null, Promise.all e eficient)
        const [metadata, rawTranscript] = await Promise.all([
            metadataPromise,
            transcriptPromise
        ]);
        
        let transcriptObject = null;

        // Procesăm transcriptul DOAR dacă există (adică doar pt YouTube)
        if (rawTranscript) {
            const translatedText = await processWithGPT(rawTranscript);
            transcriptObject = {
                original: rawTranscript,
                translated: translatedText
            };
        }

        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        const responseData = {
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration,
                formats: formats,
                transcript: transcriptObject // Va fi null pentru non-YouTube
            }
        };

        // 3. SALVĂM ÎN CACHE
        memoryCache.set(videoUrl, responseData);
        
        console.log(`✅ Gata în ${(Date.now() - startTime) / 1000}s`);
        res.json(responseData);

    } catch (error) {
        console.error('❌ Eroare:', error);
        res.status(500).json({ error: 'Eroare server.' });
    }
});

// 🚀 ENDPOINT STREAMING
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';
    
    const filename = isAudio ? 'audio.mp3' : 'video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    
    const args = [
        ...getFastArgs(),
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        '--buffer-size', '16K', 
        '--no-part', 
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server TURBO pornit pe portul ${PORT}`);
});