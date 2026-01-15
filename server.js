const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Servim fișierele statice
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// În containerul Docker instalăm yt-dlp în /usr/local/bin/
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- HELPER: Argumente standard pentru yt-dlp (Anti-Block 2024) ---
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        '--sleep-requests', '1',
        '--sleep-interval', '2',
        '--sleep-subtitles', '1'
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// --- CURĂȚARE TEXT VTT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || 
            /^\d+$/.test(line) || line.startsWith('Kind:') || 
            line.startsWith('Language:') || line.startsWith('NOTE') || 
            line.startsWith('Style:')) {
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

// --- EXTRAGERE TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const args = [
            ...getYtDlpArgs(),
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            url
        ];

        const process = spawn(YTDLP_PATH, args);

        process.on('close', () => {
            const possibleFiles = [
                `${outputTemplate}.en.vtt`,
                `${outputTemplate}.en-orig.vtt`
            ];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                try {
                    const content = fs.readFileSync(foundFile, 'utf8');
                    const text = cleanVttText(content);
                    fs.unlinkSync(foundFile);
                    resolve(text);
                } catch (e) {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

// --- TRADUCERE (GPT-4o-mini / GOOGLE) ---
async function translateText(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";

    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul următor în limba Română." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
            });
            return response.data.choices[0].message.content;
        } catch (error) {
            console.warn("⚠️ Fallback la Google Translate.");
        }
    }

    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        return "Traducere momentan indisponibilă.";
    }
}

// --- METADATA (Cu Fallback pentru Titlu) ---
async function getYtMetadata(url) {
    // Încercăm oEmbed întâi (e mai rapid și nu e blocat)
    try {
        const oembed = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
        return { title: oembed.data.title, duration_string: "--:--" };
    } catch (e) {
        return new Promise((resolve) => {
            const args = [...getYtDlpArgs(), '--dump-json', url];
            const process = spawn(YTDLP_PATH, args);
            let buffer = '';
            process.stdout.on('data', d => buffer += d);
            process.on('close', () => {
                try {
                    resolve(JSON.parse(buffer));
                } catch (e) {
                    resolve({ title: "YouTube Video", duration_string: "--:--" });
                }
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
        let originalText = await getOriginalTranscript(videoUrl);

        if (!originalText && metadata.description) {
            originalText = metadata.description.replace(/https?:\/\/\S+/g, '');
        }

        let translatedText = await translateText(originalText);

        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));

        formats.push({
            quality: '192', format: 'mp3',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string || "--:--",
                formats: formats,
                transcript: {
                    original: originalText ? originalText.substring(0, 2500) : "Nu s-a găsit text.",
                    translated: translatedText
                }
            }
        });

    } catch (error) {
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';

    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    // Scoatem sleep-ul pentru streaming ca să fie rapid
    const streamingArgs = getYtDlpArgs().filter(arg => !arg.includes('sleep'));
    const args = [
        ...streamingArgs,
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