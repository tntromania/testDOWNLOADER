const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- 1. CURĂȚARE TEXT (Clasic) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || 
            line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Tip:') || 
            line.startsWith('Limbă:') || line.startsWith('Style:')) {
            return;
        }
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE (Prioritate GPT-4o-mini) ---
async function translateWithAI(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul în limba Română." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });
            return response.data.choices[0].message.content;
        } catch (e) { console.warn("GPT Error, fallback Google."); }
    }
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { return "Traducere indisponibilă."; }
}

// --- 3. EXTRAGERE TRANSCRIPT (Metoda ta care merge) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);
    const args = [
        '--skip-download', '--write-sub', '--write-auto-sub',
        '--sub-lang', 'en', '--convert-subs', 'vtt',
        '--output', outputTemplate, '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        url
    ];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, args);
        proc.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));
            if (foundFile) {
                const content = fs.readFileSync(foundFile, 'utf8');
                const text = cleanVttText(content);
                fs.unlinkSync(foundFile);
                resolve(text);
            } else { resolve(null); }
        });
    });
}

// --- 4. METADATA (Rapid) ---
async function getYtMetadata(url) {
    try {
        const oembed = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
        return { title: oembed.data.title };
    } catch (e) {
        return new Promise((resolve) => {
            const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
            let buf = '';
            proc.stdout.on('data', d => buf += d);
            proc.on('close', () => {
                try { resolve(JSON.parse(buf)); } 
                catch (e) { resolve({ title: "YouTube Video" }); }
            });
        });
    }
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        const metadata = await getYtMetadata(videoUrl);
        const originalText = await getOriginalTranscript(videoUrl);
        const translatedText = await translateWithAI(originalText);

        const formats = ['360', '480', '720', '1080'].map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                formats: formats,
                transcript: {
                    original: originalText ? originalText.substring(0, 2500) : "Nu s-a găsit text.",
                    translated: translatedText
                }
            }
        });
    } catch (e) { res.status(500).json({ error: 'Eroare procesare.' }); }
});

// --- ENDPOINT STREAMING RAPID ---
app.get('/api/stream', (req, res) => {
    const isAudio = req.query.type === 'audio';
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = ['-o', '-', '--no-warnings', '--force-ipv4', '-f', isAudio ? 'bestaudio' : 'best', req.query.url];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server pornit pe ${PORT}`));