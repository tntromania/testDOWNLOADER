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

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Helper pentru argumente comune (Cookies + User Agent)
function getCommonArgs() {
    const args = ['--no-warnings', '--no-check-certificates', '--force-ipv4', '--referer', 'https://www.youtube.com/'];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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

// Extragere Transcript (Rapidă)
async function getTranscriptWithYtDlp(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/transcript_${Date.now()}`;
        // Adăugăm argumentele comune (Cookies)
        const args = [
            ...getCommonArgs(),
            '--skip-download', '--write-subs', '--write-auto-subs',
            '--sub-lang', 'en,ro,.*', '--sub-format', 'vtt',
            '--output', outputBase,
            url
        ];

        const process = spawn(YTDLP_PATH, args);
        process.on('close', () => {
            const dir = '/tmp';
            try {
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

// Extragere Metadata (OPTIMIZATĂ - Doar text, fără JSON greu)
async function getYtMetadata(url) {
    return new Promise(resolve => {
        // Folosim --print în loc de --dump-json pentru viteză
        const args = [
            ...getCommonArgs(),
            '--print', '%(title)s|%(duration_string)s', // Cerem doar Titlu și Durată separate prin |
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
                resolve({ title: "YouTube Video", duration: "--:--" });
            }
        });
    });
}

// Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (Lipsă API Key)";
    if (!text || text.length < 5) return "Text prea scurt.";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Tradu în Română. Păstrează sensul natural. Fără comentarii." },
                { role: "user", content: text }
            ],
            max_tokens: 1000,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        return "Eroare la traducere.";
    }
}

// API ROUTE
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('\n🎬 Processing:', videoUrl);
    const startTime = Date.now();

    try {
        // 🔥 PARALELIZARE: Lansăm ambele procese simultan!
        // Asta e cheia vitezei. Nu mai așteptăm unul după altul.
        const [metadata, rawTranscript] = await Promise.all([
            getYtMetadata(videoUrl),
            getTranscriptWithYtDlp(videoUrl)
        ]);

        console.log(`⏱️ Metadata & Transcript gata în ${(Date.now() - startTime) / 1000}s`);
        
        let transcriptObject = null;

        if (rawTranscript) {
            // Traducerea o facem doar dacă avem text, și o așteptăm doar pe ea
            const translatedText = await processWithGPT(rawTranscript);
            
            transcriptObject = {
                original: rawTranscript,
                translated: translatedText
            };
        }

        // Generare link-uri
        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        console.log(`✅ Total request time: ${(Date.now() - startTime) / 1000}s`);

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration,
                formats: formats,
                transcript: transcriptObject
            }
        });

    } catch (error) {
        console.error('❌ Eroare server:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';
    
    // Setăm titlul fișierului la download (generic, că e stream)
    const filename = isAudio ? 'audio.mp3' : 'video.mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    
    const args = [
        ...getCommonArgs(),
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});