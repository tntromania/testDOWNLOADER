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

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ⚡ CACHE ÎN MEMORIE
const memoryCache = new Map();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// 1. Configurare Argumente YT-DLP (Optimizat)
function getFastArgs() {
    const args = [
        '--no-warnings', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '--referer', 'https://www.youtube.com/',
        '--compat-options', 'no-youtube-unavailable-videos',
        '--no-playlist' 
    ];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }
    return args;
}

// 2. Curățare VTT
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

// 3. Extragere Transcript (Doar YouTube)
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

// 4. Metadata RAPID
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

// 5. Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (Lipsă API Key)";
    if (!text || text.length < 5) return "Text prea scurt pentru traducere.";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un translator. Tradu direct în limba Română. Fără explicații." },
                { role: "user", content: text }
            ],
            max_tokens: 1000,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        console.error('Eroare OpenAI:', e.message);
        return "Eroare la traducere.";
    }
}

// 🚀 ENDPOINT PRINCIPAL (/api/download)
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    // A. Check Cache
    if (memoryCache.has(videoUrl)) {
        console.log('⚡ Serving from CACHE!');
        return res.json(memoryCache.get(videoUrl));
    }

    console.log('\n🎬 Processing:', videoUrl);
    
    // B. Detect Platform
    const isYoutube = videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be');
    
    try {
        let metadata, rawTranscript = null;

        if (isYoutube) {
            console.log("🔹 YouTube detectat: AI activat.");
            [metadata, rawTranscript] = await Promise.all([
                getYtMetadata(videoUrl),
                getTranscriptWithYtDlp(videoUrl)
            ]);
        } else {
            console.log("🔹 Non-YouTube: Skip AI. Download rapid.");
            metadata = await getYtMetadata(videoUrl);
        }
        
        // C. Translate if transcript exists
        let transcriptObject = null;
        if (rawTranscript) {
            const translatedText = await processWithGPT(rawTranscript);
            transcriptObject = {
                original: rawTranscript,
                translated: translatedText
            };
        }

        // D. Generate Links
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
                transcript: transcriptObject
            }
        };

        memoryCache.set(videoUrl, responseData);
        res.json(responseData);

    } catch (error) {
        console.error('❌ Eroare server:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// 🚀 ENDPOINT STREAMING (/api/stream)
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
    
    streamProcess.stderr.on('data', (d) => {
        if(d.toString().includes('ERROR')) console.error(d.toString());
    });

    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server TURBO pornit pe portul ${PORT}`);
});