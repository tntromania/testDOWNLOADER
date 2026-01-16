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

// Extragere Transcript
async function getTranscriptWithYtDlp(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/transcript_${Date.now()}`;
        const args = [
            '--no-warnings', '--no-check-certificates', '--force-ipv4',
            '--skip-download', '--write-subs', '--write-auto-subs',
            '--sub-lang', 'en,ro,.*', '--sub-format', 'vtt',
            '--output', outputBase,
            url
        ];

        if (fs.existsSync(COOKIES_PATH)) {
            args.push('--cookies', COOKIES_PATH);
            args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }

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

// Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (Lipsă API Key)";
    if (!text || text.length < 5) return "Text prea scurt pentru traducere.";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un translator profesionist. Tradu textul următor în limba Română. Păstrează sensul, dar fă-l să sune natural. Nu adăuga comentarii, doar textul tradus." },
                { role: "user", content: text }
            ],
            max_tokens: 1500,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        console.error('❌ Eroare OpenAI:', e.message);
        return "Eroare la traducere.";
    }
}

// Metadata
async function getYtMetadata(url) {
    return new Promise(resolve => {
        const p = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
        let data = '';
        p.stdout.on('data', d => data += d);
        p.on('close', () => {
            try {
                const json = JSON.parse(data);
                resolve({ title: json.title, duration: json.duration_string });
            } catch { resolve({ title: "YouTube Video", duration: "--:--" }); }
        });
    });
}

// API ROUTE
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('\n🎬 Processing:', videoUrl);

    try {
        const metadata = await getYtMetadata(videoUrl);
        
        // 1. Luăm textul original
        const rawTranscript = await getTranscriptWithYtDlp(videoUrl);
        
        // 2. Pregătim obiectul de răspuns
        let transcriptObject = null;

        if (rawTranscript) {
            console.log(`✅ Transcript original găsit (${rawTranscript.length} chars). Trimit la GPT...`);
            
            // 3. Traducem
            const translatedText = await processWithGPT(rawTranscript);
            
            // 4. Construim obiectul pentru HTML
            transcriptObject = {
                original: rawTranscript,   // Aici vine textul englezesc (sau sursa)
                translated: translatedText // Aici vine textul românesc de la GPT
            };
        }

        // Generare link-uri download
        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        // RĂSPUNS FINAL CĂTRE HTML
        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration,
                formats: formats,
                transcript: transcriptObject // Acum trimitem OBIECTUL, nu string-ul
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
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    
    const args = ['--no-warnings', '--no-check-certificates', '--force-ipv4', '--referer', 'https://www.youtube.com/', '-o', '-', '-f', isAudio ? 'bestaudio' : 'best', videoUrl];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});