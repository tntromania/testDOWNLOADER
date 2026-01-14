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

// Setare pentru Linux/Coolify
const YTDLP_PATH = 'yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- LOGGING ---
function logStep(step, message) {
    console.log(`[${new Date().toLocaleTimeString()}] [${step}] ${message}`);
}

// --- 0. SCRIPT DEȘTEPT PENTRU COOKIES ---
if (process.env.YOUTUBE_COOKIES) {
    try {
        let content = process.env.YOUTUBE_COOKIES.replace(/^"|"$/g, '');
        
        // FIX CRITIC: Dacă utilizatorul a lipit totul pe o linie (spații în loc de Enter), reparăm automat
        if (!content.includes('\n') && content.includes('.youtube.com')) {
            console.log("⚠️ Detectat format cookies 'lipit'. Încerc să repar...");
            // Înlocuim spațiile dinaintea domeniilor cu linii noi
            content = content.replace(/\s+(\.youtube\.com)/g, '\n$1');
            // Asigurăm header-ul pe linie separată
            content = content.replace('# Netscape', '# Netscape'); 
        } else {
            // Dacă are \n literale (din copy-paste greșit), le facem linii reale
            content = content.replace(/\\n/g, '\n');
        }

        fs.writeFileSync(COOKIES_PATH, content, 'utf8');
        logStep('COOKIES', `✅ Cookies salvate (${content.split('\n').length} linii).`);
    } catch (e) {
        console.error("❌ Eroare scriere cookies:", e);
    }
}

// --- 1. CLEAN TEXT (LOGICA VECHE) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || 
            line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Style:')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRANSCRIPT (LOGICA VECHE + COOKIES) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);
    
    let args = [
        '--skip-download',
        '--write-sub', '--write-auto-sub',
        '--sub-lang', 'en', 
        '--convert-subs', 'vtt',
        '--output', outputTemplate,
        '--no-check-certificates',
        '--no-warnings'
    ];

    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push(url);

    return new Promise((resolve) => {
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
                } catch (e) { resolve(null); }
            } else { resolve(null); }
        });
    });
}

// --- 3. TRADUCERE ---
async function translateSecure(text) {
    if (!text || text.length < 5) return "Nu există text suficient.";
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { return "Traducere indisponibilă."; }
}

// --- 4. METADATA (LOGICA VECHE + DEBUG) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        let args = ['--dump-json', '--no-check-certificates', '--no-warnings'];
        if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
        args.push(url);

        const process = spawn(YTDLP_PATH, args);
        let buffer = '';
        
        process.stdout.on('data', d => buffer += d);
        process.on('close', (code) => { 
            try { 
                const data = JSON.parse(buffer);
                logStep('METADATA', `✅ Găsit: ${data.title}`);
                resolve(data); 
            } catch (e) { 
                logStep('METADATA', '⚠️ Eșec JSON. Probabil cookie expirat sau IP blocat.');
                resolve({ title: "Titlu Indisponibil", description: "", duration_string: "N/A" }); 
            } 
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    logStep('START', `Procesez: ${videoUrl}`);

    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        const metadata = await getYtMetadata(videoUrl);
        
        let originalText = await getOriginalTranscript(videoUrl);
        if (!originalText) {
            originalText = metadata.description || "Nu s-a găsit text.";
            originalText = originalText.replace(/https?:\/\/\S+/g, '');
        }

        let translatedText = "Se procesează...";
        if (originalText && originalText.length > 5 && originalText !== "Nu s-a găsit text.") {
            translatedText = await translateSecure(originalText);
        }

        // Structura pentru HTML-ul Universal Pro
        const formats = [
            {
                quality: 'MP4', 
                url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
                hasAudio: true, hasVideo: true
            },
            {
                quality: 'MP3',
                url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
                hasAudio: true, hasVideo: false
            }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: {
                    original: originalText,
                    translated: translatedText
                }
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// --- STREAMING ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    let args = ['-o', '-', '--no-warnings', '--no-check-certificates', '--force-ipv4', '-f', isAudio ? 'bestaudio' : 'best'];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push(url);

    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server FINAL pornit pe ${PORT}`);
});