const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

// ================= CONFIG =================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// IMPORTANT: yt-dlp LOCAL (recomandat pt Coolify)
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ================= HELPERS =================

function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// Curățare VTT
function cleanVttText(vttContent) {
    if (!vttContent) return "";

    const lines = vttContent.split('\n');
    let cleanText = [];
    let seen = new Set();

    for (let line of lines) {
        line = line.trim();
        if (
            !line ||
            line.includes('-->') ||
            line.startsWith('WEBVTT') ||
            /^\d+$/.test(line) ||
            line.startsWith('Kind:') ||
            line.startsWith('Language:')
        ) continue;

        line = line.replace(/<[^>]*>/g, '');
        if (!seen.has(line) && line.length > 1) {
            seen.add(line);
            cleanText.push(line);
        }
    }
    return cleanText.join(' ');
}

// ================= TRANSCRIPT =================

async function getOriginalTranscript(url) {
    const id = Date.now();
    const out = path.join(__dirname, `trans_${id}`);

    return new Promise(resolve => {
        const args = [
            '--skip-download',
            '--write-sub',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', out,
            '--no-warnings',
            '--no-check-certificates',
            url
        ];

        const proc = spawn(YTDLP_PATH, args);

        proc.on('close', () => {
            const files = [
                `${out}.en.vtt`,
                `${out}.en-orig.vtt`
            ];

            const found = files.find(f => fs.existsSync(f));
            if (!found) return resolve(null);

            try {
                const content = fs.readFileSync(found, 'utf8');
                fs.unlinkSync(found);
                resolve(cleanVttText(content));
            } catch {
                resolve(null);
            }
        });
    });
}

// ================= METADATA =================

function getYtMetadata(url) {
    return new Promise(resolve => {
        const proc = spawn(YTDLP_PATH, [
            '--dump-json',
            '--no-warnings',
            '--no-check-certificates',
            url
        ]);

        let buffer = '';
        proc.stdout.on('data', d => buffer += d.toString());

        proc.on('close', () => {
            try {
                resolve(JSON.parse(buffer.trim()));
            } catch {
                resolve({
                    title: 'Video',
                    duration_string: 'N/A',
                    description: ''
                });
            }
        });
    });
}

// ================= TRANSLATE =================

async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există text.";

    try {
        const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Tradu textul în română, natural, fără explicații.' },
                    { role: 'user', content: text.substring(0, 4000) }
                ],
                temperature: 0.3
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.data.choices[0].message.content;
    } catch {
        const fallback = await translate(text.substring(0, 4500), { to: 'ro' });
        return fallback.text;
    }
}

// ================= API =================

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`[${platform}] ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);

        let transcript = null;

        if (platform === 'youtube') {
            let original = await getOriginalTranscript(videoUrl);

            if (!original && metadata.description?.length > 50) {
                original = metadata.description.replace(/https?:\/\/\S+/g, '');
            }

            if (original) {
                const translated = await translateWithGPT(original);
                transcript = { original, translated };
            }
        }

        const formats = [
            { format: 'mp4', url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` },
            { format: 'mp3', url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title || 'Video',
                duration: metadata.duration_string || 'N/A',
                formats,
                transcript
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================= STREAM =================

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';

    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`
    );

    const args = [
        '-o', '-',
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '-f', isAudio ? 'bestaudio' : 'best',
        url
    ];

    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
});

// ================= FALLBACK =================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= START =================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVER FINAL pornit pe ${PORT}`);
});
