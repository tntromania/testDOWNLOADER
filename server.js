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
// Servim fișierele statice
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- 1. SETĂRI SCRAPING (Transcript & Metadata) ---
// Aici folosim "sleep" ca să nu luăm ban de la YouTube când cerem date text
function getScrapingArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        // Încetinim puțin cererile de text pentru siguranță
        '--sleep-requests', '1',
    ];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    return args;
}

// --- 2. SETĂRI STREAMING (Viteză Maximă) ---
// Aici NU punem sleep, vrem să descarce cât mai repede video-ul
function getStreamingArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        // Buffer mare pentru stabilitate
        '--buffer-size', '16K',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    return args;
}

// --- 3. CURĂȚARE TEXT VTT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('NOTE') || line.startsWith('Style:')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 4. EXTRAGERE TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);
    return new Promise((resolve) => {
        const args = [
            ...getScrapingArgs(),
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            url
        ];
        
        console.log(`[DEBUG] Caut transcript...`);
        const process = spawn(YTDLP_PATH, args);
        
        process.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));
            if (foundFile) {
                try {
                    const content = fs.readFileSync(foundFile, 'utf8');
                    const text = cleanVttText(content);
                    fs.unlinkSync(foundFile);
                    resolve(text);
                } catch (e) { console.error(e); resolve(null); }
            } else { resolve(null); }
        });
    });
}

// --- 5. TRADUCERE (GPT / Google) ---
async function translateText(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    // Încercăm GPT
    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul în Română. Păstrează sensul exact." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });
            return response.data.choices[0].message.content;
        } catch (error) { console.warn("GPT Error, fallback Google"); }
    }
    
    // Fallback Google
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { return "Traducere indisponibilă."; }
}

// --- 6. FALLBACK TITLU (Secretul pentru titlu corect) ---
async function getVideoTitleFallback(url) {
    try {
        // Luăm titlul prin API public, fără a folosi yt-dlp care e blocat
        const response = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
        return response.data.title;
    } catch (e) {
        return null;
    }
}

// --- 7. METADATA (Cu logică de reparare erori) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const args = [...getScrapingArgs(), '--dump-json', url];
        const process = spawn(YTDLP_PATH, args);
        let buffer = '';
        
        process.stdout.on('data', d => buffer += d);
        
        process.on('close', async () => {
            try {
                if(!buffer) throw new Error("Empty buffer");
                const data = JSON.parse(buffer);
                resolve(data);
            } catch (e) {
                console.log("⚠️ Metadata blocat de yt-dlp. Activez fallback titlu...");
                // Dacă yt-dlp nu poate lua JSON-ul (din cauza cookies/bot), luăm doar titlul manual
                const fallbackTitle = await getVideoTitleFallback(url);
                resolve({ 
                    title: fallbackTitle || "Video YouTube (Titlu Protejat)", 
                    description: "", 
                    duration_string: "--:--" 
                });
            }
        });
    });
}

// --- ENDPOINT PRINCIPAL: DOWNLOAD INFO ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    console.log(`\n[INFO] Procesez: ${videoUrl}`);

    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        // PAS 1: Luăm Titlul și Durata
        const metadata = await getYtMetadata(videoUrl);
        console.log(`✓ Titlu: ${metadata.title}`);

        // PAS 2: Luăm Transcriptul
        let originalText = await getOriginalTranscript(videoUrl);
        
        // Dacă nu există transcript, luăm descrierea
        if (!originalText && metadata.description) {
            console.log("-> Folosesc descrierea ca text.");
            originalText = metadata.description.replace(/https?:\/\/\S+/g, '');
        }

        // PAS 3: Traducem
        let translatedText = await translateText(originalText);

        // PAS 4: Pregătim link-urile de streaming
        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
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
        console.error("Critical Error:", error);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

// --- ENDPOINT SECUNDAR: STREAMING VIDEO/AUDIO ---
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const type = req.query.type;
    const isAudio = type === 'audio';

    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    // Aici folosim argumentele DE VITEZĂ (fără sleep)
    const args = [
        ...getStreamingArgs(), 
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    
    // Dacă utilizatorul anulează descărcarea, oprim procesul pe server
    req.on('close', () => {
        streamProcess.kill();
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server FINAL pornit pe ${PORT}`);
    if (fs.existsSync(COOKIES_PATH)) console.log("🍪 Cookies active.");
});