const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YTDLP_PATH = 'yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ---------------- CLEAN VTT ----------------
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    const seen = new Set();
    const out = [];

    for (let line of lines) {
        line = line.trim();
        if (
            !line ||
            line.startsWith('WEBVTT') ||
            line.includes('-->') ||
            /^\d+$/.test(line) ||
            line.startsWith('Kind:') ||
            line.startsWith('Language:') ||
            line.startsWith('Style:')
        ) continue;

        line = line.replace(/<[^>]*>/g, '');
        if (!seen.has(line)) {
            seen.add(line);
            out.push(line);
        }
    }
    return out.join(' ');
}

// ---------------- METADATA ----------------
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const p = spawn(YTDLP_PATH, [
            '--cookies', COOKIES_PATH,
            '--dump-json',
            '--no-warnings',
            url
        ]);

        let buf = '';
        p.stdout.on('data', d => buf += d);
        p.on('close', () => {
            try {
                resolve(JSON.parse(buf));
            } catch {
                resolve({ title: 'YouTube Video', description: '', duration_string: 'N/A' });
            }
        });
    });
}

// ---------------- TRANSCRIPT ----------------
function getOriginalTranscript(url) {
    return new Promise((resolve) => {
        const id = Date.now();
        const out = `trans_${id}`;

        const p = spawn(YTDLP_PATH, [
            '--cookies', COOKIES_PATH,
            '--skip-download',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '-o', out,
            url
        ]);

        p.on('close', () => {
            const file = `${out}.en.vtt`;
            if (!fs.existsSync(file)) return resolve(null);

            const text = cleanVttText(fs.readFileSync(file, 'utf8'));
            fs.unlinkSync(file);
            resolve(text);
        });
    });
}

// ---------------- TRANSLATE ----------------
async function translateSecure(text) {
    if (!text || text.length < 10) return "Nu există text suficient.";
    try {
        const res = await translate(text.slice(0, 4500), { to: 'ro' });
        return res.text;
    } catch {
        return "Traducere indisponibilă.";
    }
}

// ---------------- API ----------------
app.get('/api/download', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    try {
        const meta = await getYtMetadata(url);
        let transcript = await getOriginalTranscript(url);

        if (!transcript) {
            transcript = meta.description?.replace(/https?:\/\/\S+/g, '') || '';
        }

        const translated = await translateSecure(transcript);

        res.json({
            status: 'ok',
            data: {
                title: meta.title,
                duration: meta.duration_string,
                transcript: {
                    original: transcript,
                    translated
                },
                formats: [
                    {
                        quality: '1080p',
                        format: 'mp4',
                        url: `/api/stream?url=${encodeURIComponent(url)}&type=video`
                    },
                    {
                        quality: '192kbps',
                        format: 'mp3',
                        url: `/api/stream?url=${encodeURIComponent(url)}&type=audio`
                    }
                ]
            }
        });

    } catch (e) {
        res.status(500).json({ error: 'Eroare server' });
    }
});

// ---------------- STREAM ----------------
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const audio = type === 'audio';

    res.setHeader('Content-Type', audio ? 'audio/mpeg' : 'video/mp4');

    const p = spawn(YTDLP_PATH, [
        '--cookies', COOKIES_PATH,
        '-f', audio ? 'bestaudio' : 'best',
        '-o', '-',
        url
    ]);

    p.stdout.pipe(res);
});

// ---------------- START ----------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe port ${PORT}`);
});
