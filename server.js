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

/* =========================
   UTIL: CLEAN VTT
========================= */
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
        if (!seen.has(line) && line.length > 1) {
            seen.add(line);
            out.push(line);
        }
    }
    return out.join(' ');
}

/* =========================
   METADATA
========================= */
function formatDuration(sec) {
    if (!sec) return 'N/A';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function getYtMetadata(url) {
    return new Promise((resolve, reject) => {
        console.log(`🔍 Fetching metadata for: ${url}`);
        const p = spawn(YTDLP_PATH, [
            '--cookies', COOKIES_PATH,
            '--dump-single-json',
            '--no-warnings',
            url
        ]);

        let buf = '';
        p.stdout.on('data', d => buf += d);
        p.stderr.on('data', d => console.log('yt-dlp stderr:', d.toString()));

        p.on('close', () => {
            try {
                const json = JSON.parse(buf);
                const title = json.title || 'YouTube Video';
                const description = json.description || '';
                const duration = formatDuration(json.duration);
                resolve({ title, description, duration });
            } catch (err) {
                console.error('❌ Metadata parsing error:', err);
                resolve({ title: 'YouTube Video', description: '', duration: 'N/A' });
            }
        });
    });
}

/* =========================
   TRANSCRIPT (EN + EN-ORIG)
========================= */
function getOriginalTranscript(url) {
    return new Promise((resolve) => {
        const id = Date.now();
        const out = `trans_${id}`;
        console.log(`📝 Generating transcript for: ${url}`);

        const p = spawn(YTDLP_PATH, [
            '--cookies', COOKIES_PATH,
            '--skip-download',
            '--write-sub',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '-o', out,
            url
        ]);

        p.stderr.on('data', d => console.log('yt-dlp stderr:', d.toString()));

        p.on('close', () => {
            const possibleFiles = [
                `${out}.en.vtt`,
                `${out}.en-orig.vtt`
            ];

            const found = possibleFiles.find(f => fs.existsSync(f));
            if (!found) return resolve(null);

            try {
                const content = fs.readFileSync(found, 'utf8');
                const text = cleanVttText(content);
                fs.unlinkSync(found);
                resolve(text);
            } catch {
                resolve(null);
            }
        });
    });
}

/* =========================
   TRANSLATE
========================= */
async function translateSecure(text) {
    if (!text || text.length < 10) return "Nu există text suficient.";
    try {
        const res = await translate(text.slice(0, 4500), { to: 'ro' });
        return res.text;
    } catch {
        return "Traducere indisponibilă.";
    }
}

/* =========================
   API: DOWNLOAD INFO
========================= */
app.get('/api/download', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`📥 New request: ${url}`);

    try {
        const meta = await getYtMetadata(url);

        let transcript = await getOriginalTranscript(url);
        if (!transcript || transcript.length < 5) {
            transcript = meta.description?.replace(/https?:\/\/\S+/g, '') || '';
        }

        const translated = await translateSecure(transcript);

        console.log(`✅ Metadata ready: ${meta.title} | Duration: ${meta.duration}`);

        res.json({
            status: 'ok',
            data: {
                title: meta.title,
                duration: meta.duration,
                transcript: {
                    original: transcript || "Fără text disponibil.",
                    translated
                },
                formats: [
                    {
                        quality: '1080p',
                        format: 'mp4',
                        url: `/api/stream?url=${encodeURIComponent(url)}&type=video`
                    },
                    {
                        quality: '192',
                        format: 'mp3',
                        url: `/api/stream?url=${encodeURIComponent(url)}&type=audio`
                    }
                ]
            }
        });

    } catch (err) {
        console.error('❌ Error processing request:', err);
        res.status(500).json({ error: 'Eroare server' });
    }
});

/* =========================
   API: STREAM
========================= */
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';

    console.log(`📦 Streaming ${type} for: ${url}`);

    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`
    );
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const args = [
        '--cookies', COOKIES_PATH,
        '-f', isAudio ? 'bestaudio' : 'best',
        '-o', '-',
        url
    ];

    const p = spawn(YTDLP_PATH, args);
    p.stdout.pipe(res);

    p.stderr.on('data', d => console.log('yt-dlp stderr:', d.toString()));
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe port ${PORT}`);
});
