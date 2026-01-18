const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process'); // Am adaugat exec pentru update
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

// ⚡ CACHE ÎN MEMORIE (Cu curățare automată)
const memoryCache = new Map();

// 🔥 FIX: Curățăm cache-ul la fiecare 24h ca să nu crape serverul de la memorie plină
setInterval(() => {
    console.log('🧹 Golire cache automat...');
    memoryCache.clear();
}, 24 * 60 * 60 * 1000);

// 🔥 FIX: Endpoint pentru a actualiza yt-dlp manual sau prin cron
app.get('/api/admin/update-ytdlp', (req, res) => {
    exec(`${YTDLP_PATH} -U`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Update error: ${error}`);
            return res.status(500).json({ error: stderr });
        }
        console.log(`Update yt-dlp: ${stdout}`);
        res.json({ message: 'Update success', log: stdout });
    });
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

function isYoutubeUrl(url) {
    return /(youtube\.com|youtu\.be)/i.test(url);
}

function getFastArgs() {
    const args = [
        '--no-warnings', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '--referer', 'https://www.google.com/',
        '--compat-options', 'no-youtube-unavailable-videos',
        '--no-playlist'
    ];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
        // 🔥 User Agent mai nou pentru a pacali YouTube
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    }
    return args;
}

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
        
        // 🔥 DEBUG: Vedem erorile în logs dacă nu merge transcriptul
        process.stderr.on('data', (data) => console.error(`[Transcript Error]: ${data}`));

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
        let errorData = '';

        p.stdout.on('data', d => data += d);
        // 🔥 FIX: Capturăm eroarea reală
        p.stderr.on('data', d => errorData += d);
        
        p.on('close', (code) => {
            const parts = data.trim().split('|');
            if (parts.length >= 2) {
                resolve({ title: parts[0], duration: parts[1] });
            } else {
                console.error(`❌ Metadata Failed for ${url}. Exit code: ${code}`);
                console.error(`❌ STDERR: ${errorData}`); // Asta va aparea in Coolify logs
                resolve({ title: "Video Download (Error)", duration: "--:--" });
            }
        });
    });
}

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

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    if (memoryCache.has(videoUrl)) {
        console.log('⚡ Serving from CACHE (Instant)!');
        return res.json(memoryCache.get(videoUrl));
    }

    console.log('\n🎬 Processing:', videoUrl);
    const startTime = Date.now();
    const isYt = isYoutubeUrl(videoUrl);

    try {
        let metadataPromise = getYtMetadata(videoUrl);
        let transcriptPromise;

        if (isYt) {
            transcriptPromise = getTranscriptWithYtDlp(videoUrl);
        } else {
            transcriptPromise = Promise.resolve(null);
        }

        const [metadata, rawTranscript] = await Promise.all([
            metadataPromise,
            transcriptPromise
        ]);
        
        let transcriptObject = null;

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
                transcript: transcriptObject
            }
        };

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
    
    // Nu setam Content-Length pentru ca e stream, dar setam tipul
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

    // 🔥 FIX: Logam erorile de la stream ca sa intelegem de ce da 0 bytes
    streamProcess.stderr.on('data', (data) => {
        console.error(`[Stream Error]: ${data}`);
    });

    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server TURBO pornit pe portul ${PORT}`);
    // Optional: Ruleaza update la start
    // exec(`${YTDLP_PATH} -U`); 
});