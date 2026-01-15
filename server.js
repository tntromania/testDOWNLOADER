const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = 'yt-dlp';

// --- CURĂȚARE TEXT VTT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";

    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();

        if (
            !line ||
            line.startsWith('WEBVTT') ||
            line.includes('-->') ||
            /^\d+$/.test(line) ||
            line.startsWith('Kind:') ||
            line.startsWith('Language:') ||
            line.startsWith('NOTE') ||
            line.startsWith('Style:')
        ) {
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

// --- EXTRAGERE TRANSCRIPT (LOGICA FUNCȚIONALĂ) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const args = [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            '--no-warnings',
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
                    console.error("Eroare citire fișier:", e);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

// --- TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        console.error("Eroare Google Translate:", err.message);
        return "Traducere momentan indisponibilă.";
    }
}

// --- TRADUCERE GPT (dacă există API KEY) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";

    if (!OPENAI_API_KEY) {
        console.log("⚠️ OPENAI_API_KEY lipsă, folosesc Google Translate");
        return await translateWithGoogle(text);
    }

    const textToTranslate = text.substring(0, 4000);
    console.log("🤖 GPT-4o-mini începe traducerea...");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Ești un traducător profesionist. Tradu textul următor în limba Română. Păstrează sensul exact, dar fă-l să sune natural. Nu adăuga note explicative." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.warn("⚠️ Eroare OpenAI:", error.message);
        return await translateWithGoogle(text);
    }
}

// --- METADATA VIDEO ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => {
            try {
                resolve(JSON.parse(buffer));
            } catch (e) {
                console.error("Eroare parsare JSON:", e.message);
                resolve({ title: "YouTube Video", description: "", duration_string: "N/A" });
            }
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    console.log(`\n[INFO] Procesez: ${videoUrl}`);

    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        // 1. Metadata
        const metadata = await getYtMetadata(videoUrl);
        console.log(`✓ Titlu: ${metadata.title}`);

        // 2. Transcript
        console.log("-> Caut transcript...");
        let originalText = await getOriginalTranscript(videoUrl);

        if (!originalText && metadata.description) {
            console.log("-> Nu am găsit subtitrare, folosesc descrierea.");
            originalText = metadata.description.replace(/https?:\/\/\S+/g, '');
        }

        // 3. Traducere
        let translatedText = "Se procesează...";
        if (originalText && originalText.length > 5) {
            translatedText = await translateWithGPT(originalText);
        } else {
            translatedText = "Nu există conținut text de tradus.";
        }

        // 4. Formate (CU CÂMPUL format inclus!)
        const qualities = ['360', '480', '720', '1080'];
        const formats = [];

        qualities.forEach(q => {
            formats.push({
                quality: q + 'p',
                format: 'mp4',
                url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
                hasAudio: true,
                hasVideo: true
            });
        });

        formats.push({
            quality: '192',
            format: 'mp3',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
            hasAudio: true,
            hasVideo: false
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title || "Video Fără Titlu",
                duration: metadata.duration_string || "N/A",
                formats: formats,
                transcript: {
                    original: originalText ? originalText.substring(0, 3000) : "Nu s-a găsit text.",
                    translated: translatedText
                }
            }
        });

        console.log(`✓ Gata! Trimis către client.`);

    } catch (error) {
        console.error("❌ Eroare:", error.message);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const type = req.query.type;
    const isAudio = type === 'audio';

    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const args = [
        '-o', '-',
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);

    streamProcess.on('error', (err) => {
        console.error("Stream error:", err);
    });
});

// --- RUTA FALLBACK ---
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Index.html not found');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/download`);
    if (OPENAI_API_KEY) {
        console.log(`🤖 OpenAI GPT: ACTIVAT`);
    } else {
        console.log(`🔄 Google Translate: ACTIVAT (fallback)`);
    }
});
