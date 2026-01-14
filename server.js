const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003; // Portul pentru Coolify

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Comanda yt-dlp pentru Linux
const YTDLP_PATH = 'yt-dlp'; 

// --- 1. Funcție: CURĂȚARE TEXT (Logica ta clasică) ---
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
            line.startsWith('Tip:') ||
            line.startsWith('Limbă:') ||
            line.startsWith('Style:')
        ) return;

        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. Funcție: Descarcă Transcriptul (Logica ta clasică) ---
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
            url
        ];

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

// --- 3. Funcție: Traducere ---
async function translateSecure(text) {
    if (!text || text.length < 5) return "Nu există text suficient.";
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { return "Traducere momentan indisponibilă."; }
}

// --- 4. Funcție: Metadata (Logica ta clasică) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => { 
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                resolve({ title: "YouTube Video", description: "", duration_string: "N/A" }); 
            } 
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    console.log(`[START] Procesez: ${videoUrl}`);

    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        // A. Luăm Info Video
        const metadata = await getYtMetadata(videoUrl);
        
        // B. Luăm Transcriptul
        let originalText = await getOriginalTranscript(videoUrl);
        if (!originalText) {
            originalText = metadata.description || "Nu s-a găsit text.";
            originalText = originalText.replace(/https?:\/\/\S+/g, '');
        }

        // C. Traducem
        let translatedText = "Fără traducere disponibilă.";
        if (originalText && originalText.length > 5 && originalText !== "Nu s-a găsit text.") {
            translatedText = await translateSecure(originalText);
        }

        // D. Pregătim Formatele (POTRIVIRE 100% CU SCRIPTUL DIN INDEX)
        const formats = [
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
        ];

        // Răspunsul JSON pe care processVideo() îl așteaptă
        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string || "N/A",
                formats: formats,
                transcript: {
                    original: originalText,
                    translated: translatedText
                }
            }
        });
        console.log(`[SUCCESS] Date trimise pentru: ${metadata.title}`);

    } catch (error) {
        console.error("Eroare server:", error.message);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const args = [
        '-o', '-', 
        '--no-warnings', 
        '--no-check-certificates', 
        '--force-ipv4', 
        '-f', isAudio ? 'bestaudio' : 'best', 
        url
    ];

    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server sincronizat cu Frontend pornit pe ${PORT}`);
});