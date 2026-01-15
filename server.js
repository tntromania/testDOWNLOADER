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
// Servim fișierele statice (index.html, css) din folderul curent sau public
app.use(express.static(path.join(__dirname, 'public'))); 
// Fallback pentru root dacă index.html e în același folder cu server.js
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// În containerul Docker instalăm yt-dlp în /usr/local/bin/
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- HELPER: Argumente standard pentru yt-dlp (Anti-Block) ---
// --- HELPER: Argumente standard pentru yt-dlp (Anti-Block 2024) ---
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        // Update la un User Agent modern (Chrome 120+)
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        // Adăugăm sleep pentru a nu bombarda serverul (pare comportament uman)
        '--sleep-requests', '1',
        '--sleep-interval', '2',
        '--sleep-subtitles', '1'
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
} args;
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
        // Combinăm argumentele de bază cu cele specifice pentru subtitrări
        const args = [
            ...getYtDlpArgs(),
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            url
        ];

        console.log(`[DEBUG] Comandă transcript: ${YTDLP_PATH} ${args.join(' ')}`);
        const process = spawn(YTDLP_PATH, args);

        process.on('close', (code) => {
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
                    console.error("Eroare citire fișier subtitrare:", e);
                    resolve(null);
                }
            } else {
                console.warn("Nu s-a generat niciun fișier de subtitrare.");
                resolve(null);
            }
        });
    });
}

// --- TRADUCERE (GOOGLE / GPT) ---
async function translateText(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";

    // 1. Încercăm GPT dacă avem cheie
    if (OPENAI_API_KEY) {
        try {
            console.log("🤖 GPT-4o-mini începe traducerea...");
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul următor în limba Română. Păstrează sensul exact." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
            });
            return response.data.choices[0].message.content;
        } catch (error) {
            console.warn("⚠️ Eroare OpenAI, trec la Google:", error.message);
        }
    }

    // 2. Fallback Google Translate
    try {
        console.log("🔄 Google Translate...");
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        return "Traducere momentan indisponibilă.";
    }
}

// --- METADATA VIDEO ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const args = [
            ...getYtDlpArgs(),
            '--dump-json',
            url
        ];
        
        const process = spawn(YTDLP_PATH, args);
        let buffer = '';
        
        process.stdout.on('data', d => buffer += d);
        process.stderr.on('data', d => console.error(`[YTDLP ERR]: ${d}`));

        process.on('close', () => {
            try {
                if(!buffer) throw new Error("Buffer gol");
                resolve(JSON.parse(buffer));
            } catch (e) {
                console.error("Eroare parsare JSON Metadata:", e.message);
                // Returnăm un obiect minim ca să nu crape frontend-ul
                resolve({ 
                    title: "Titlu Indisponibil (Verifică Cookies)", 
                    description: "", 
                    duration_string: "--:--" 
                });
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
        console.log(`✓ Titlu găsit: ${metadata.title}`);

        // 2. Transcript
        console.log("-> Caut transcript...");
        let originalText = await getOriginalTranscript(videoUrl);

        if (!originalText && metadata.description) {
            console.log("-> Nu am găsit subtitrare, folosesc descrierea.");
            originalText = metadata.description.replace(/https?:\/\/\S+/g, '');
        }

        // 3. Traducere
        let translatedText = await translateText(originalText);

        // 4. Construire răspuns
        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p',
            format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
            hasAudio: true, hasVideo: true
        }));

        formats.push({
            quality: '192', format: 'mp3',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
            hasAudio: true, hasVideo: false
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: {
                    original: originalText ? originalText.substring(0, 3000) : "Nu s-a găsit text.",
                    translated: translatedText
                }
            }
        });

    } catch (error) {
        console.error("❌ Eroare server:", error);
        res.status(500).json({ error: 'Eroare internă la procesare.' });
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
        ...getYtDlpArgs(), // Folosim aceleași argumente cu cookies și aici!
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    streamProcess.stderr.on('data', d => console.log(`Stream stderr: ${d}`));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
    if (fs.existsSync(COOKIES_PATH)) {
        console.log("🍪 Cookies.txt detectat și încărcat!");
    } else {
        console.warn("⚠️  ATENȚIE: cookies.txt lipsește! Descărcările pot eșua pe server.");
    }
});