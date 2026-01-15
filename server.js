const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

// ================= CONFIG =================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const YTDLP_PATH = process.platform === 'win32'
    ? path.join(__dirname, 'yt-dlp.exe')
    : 'yt-dlp';

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ================= UTILS =================
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--quiet',
        '--force-ipv4',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    ];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

function cleanVttText(vtt) {
    return vtt
        .split('\n')
        .filter(l =>
            l &&
            !l.includes('-->') &&
            !l.startsWith('WEBVTT') &&
            !/^\d+$/.test(l)
        )
        .map(l => l.replace(/<[^>]+>/g, '').trim())
        .join(' ');
}

// ================= TRANSCRIPT =================
async function getOriginalTranscript(url) {
    return new Promise((resolve) => {
        const args = [...getYtDlpArgs(), '--dump-json', '--skip-download', url];

        const proc = spawn(YTDLP_PATH, args, {
            stdio: ['ignore', 'pipe', 'ignore']
        });

        let out = '';
        proc.stdout.on('data', d => out += d.toString());

        proc.on('close', async () => {
            try {
                const data = JSON.parse(out);

                const captions =
                    data.automatic_captions?.en ||
                    data.subtitles?.en ||
                    null;

                if (!captions) {
                    console.log('❌ Transcript inexistent');
                    return resolve(null);
                }

                const vttUrl = captions.find(c => c.ext === 'vtt')?.url;
                if (!vttUrl) return resolve(null);

                const res = await axios.get(vttUrl);
                console.log('✅ Transcript identificat');

                resolve(cleanVttText(res.data));
            } catch {
                resolve(null);
            }
        });
    });
}

// ================= GPT TRANSLATE =================
async function translateWithGPT(text) {
    if (!OPENAI_API_KEY || !text) return 'Traducere indisponibilă';

    console.log('🤖 Traducere cu GPT...');

    const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content:
                        'Ești un traducător profesionist. Tradu în română natural, fără explicații.'
                },
                {
                    role: 'user',
                    content: text.substring(0, 5000)
                }
            ],
            temperature: 0.3
        },
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`
            }
        }
    );

    return res.data.choices[0].message.content;
}

// ================= METADATA =================
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const args = [...getYtDlpArgs(), '--dump-json', url];
        const proc = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'ignore'] });

        let buf = '';
        proc.stdout.on('data', d => buf += d);

        proc.on('close', () => {
            try {
                const d = JSON.parse(buf);
                resolve({
                    title: d.title || 'Video',
                    duration: d.duration_string || ''
                });
            } catch {
                resolve({ title: 'Video', duration: '' });
            }
        });
    });
}

// ================= API =================
app.get('/api/download', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    try {
        const meta = await getYtMetadata(url);

        const transcript = await getOriginalTranscript(url);
        let translated = null;

        if (transcript) {
            translated = await translateWithGPT(transcript);
        }

        const base = `${req.protocol}://${req.get('host')}`;

        res.json({
            status: 'ok',
            data: {
                title: meta.title,
                duration: meta.duration,
                transcript: {
                    original: transcript,
                    translated: translated
                },
                formats: [
                    {
                        format: 'mp4',
                        quality: 'best',
                        url: `${base}/api/stream?url=${encodeURIComponent(url)}`
                    },
                    {
                        format: 'mp3',
                        quality: 'audio',
                        url: `${base}/api/stream?url=${encodeURIComponent(url)}&audio=1`
                    }
                ]
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.get('/api/stream', (req, res) => {
    const url = req.query.url;
    const isAudio = req.query.audio;

    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`
    );

    const args = [
        ...getYtDlpArgs(),
        '-o',
        '-',
        '-f',
        isAudio ? 'bestaudio' : 'best',
        url
    ];

    const proc = spawn(YTDLP_PATH, args, {
        stdio: ['ignore', 'pipe', 'ignore']
    });

    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

// ================= START =================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});
