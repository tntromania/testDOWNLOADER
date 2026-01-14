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

// yt-dlp instalat în Docker
const YTDLP_PATH = 'yt-dlp';

/* ===============================
   UTIL – Curățare VTT
================================ */
function cleanVttText(vttContent) {
    if (!vttContent) return '';
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

/* ===============================
   METADATA – stabil
================================ */
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const p = spawn(YTDLP_PATH, [
            '--dump-json',
            '--no-warnings',
            '--no-check-certificates',
            '--force-ipv4',
            url
        ]);

        let buffer = '';

        p.stdout.on('data', d => buffer += d.toString());
        p.stderr.on('data', d => console.error('META ERR:', d.toString()));

        p.on('close', () => {
            try {
                const j = JSON.parse(buffer);
                resolve({
                    title: j.title || 'YouTube Video',
                    description: j.description || '',
                    duration_string:
                        j.duration_string ||
                        (j.duration
                            ? `${Math.floor(j.duration / 60)}:${String(j.duration % 60).padStart(2, '0')}`
                            : 'N/A')
                });
            } catch {
                resolve({
                    title: 'YouTube Video',
                    description: '',
                    duration_string: 'N/A'
                });
            }
        });
    });
}

/* ===============================
   TRANSCRIPT – NU MAI DĂ RATEURI
================================ */
function getOriginalTranscript(url) {
    return new Promise((resolve) => {
        const id = Date.now();
        const base = path.join(__dirname, `subs_${id}`);

        const p = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-auto-sub',
            '--write-sub',
            '--sub-lang', 'en,ro,.*',
            '--sub-format', 'vtt',
            '--convert-subs', 'vtt',
            '-o', base,
            '--no-warnings',
            '--no-check-certificates',
            url
        ]);

        p.stderr.on('data', d => console.error('SUB ERR:', d.toString()));

        p.on('close', () => {
            let text = '';

            try {
                const files = fs.readdirSync(__dirname)
                    .filter(f => f.startsWith(`subs_${id}`) && f.endsWith('.vtt'));

                for (const f of files) {
                    const content = fs.readFileSync(path.join(__dirname, f), 'utf8');
                    text += ' ' + cleanVttText(content);
                    fs.unlinkSync(path.join(__dirname, f));
                }
            } catch (e) {
                console.error('SUB READ ERR:', e.message);
            }

            resolve(text.trim() || null);
        });
    });
}

/* ===============================
   TRADUCERE
================================ */
async function translateSecure(text) {
    if (!text || text.length < 5) return 'Fără traducere disponibilă.';
    try {
        const res = await translate(text.slice(0, 4500), { to: 'ro' });
        return res.text;
    } catch {
        return 'Traducere indisponibilă.';
    }
}

/* ===============================
   API DOWNLOAD
================================ */
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('[START]', videoUrl);

    try {
        // A. Metadata
        const metadata = await getYtMetadata(videoUrl);

        // B. Transcript
        let originalText = await getOriginalTranscript(videoUrl);

        // Fallback: description
        if (!originalText) {
            originalText = (metadata.description || '').replace(/https?:\/\/\S+/g, '');
        }

        // C. Traducere
        let translatedText = 'Fără traducere disponibilă.';
        if (originalText && originalText.length > 5) {
            translatedText = await translateSecure(originalText);
        }

        // D. Formate
        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: [
                    {
                        quality: '1080p',
                        format: 'mp4',
                        url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
                        hasVideo: true,
                        hasAudio: true
                    },
                    {
                        quality: '192kbps',
                        format: 'mp3',
                        url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
                        hasVideo: false,
                        hasAudio: true
                    }
                ],
                transcript: {
                    original: originalText || 'Nu s-a găsit text.',
                    translated: translatedText
                }
            }
        });

        console.log('[SUCCESS]', metadata.title);

    } catch (e) {
        console.error('SERVER ERR:', e);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

/* ===============================
   STREAM VIDEO / AUDIO
================================ */
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';

    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`
    );
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const p = spawn(YTDLP_PATH, [
        '-o', '-',
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '-f', isAudio ? 'bestaudio' : 'best',
        url
    ]);

    p.stderr.on('data', d => console.error('STREAM ERR:', d.toString()));
    p.stdout.pipe(res);
});

/* ===============================
   FRONTEND FALLBACK
================================ */
app.get('*', (_, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe port ${PORT}`);
});
