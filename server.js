const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003; // Portul setat în Coolify

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MODIFICARE CRITICĂ PENTRU COOLIFY: Folosim 'yt-dlp' simplu, fără .exe
const YTDLP_PATH = 'yt-dlp'; 

// --- 1. Funcție: CURĂȚARE TEXT (Logica Veche) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        // Filtre pentru a curăța mizeria din subtitrări
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

// --- 2. Funcție: Descarcă Transcriptul (Logica Veche) ---
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
            '--no-warnings', // Important pe server ca să nu umplem logurile de erori false
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
                    fs.unlinkSync(foundFile); // Ștergem fișierul temporar
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

// --- 4. Funcție: Metadata (Logica Veche - Dump JSON) ---
// Asta extrage sigur Titlul și Durata
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => { 
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                // Fallback dacă crapă, ca să nu moară serverul
                resolve({ title: "Video (Titlu Indisponibil)", description: "", duration_string: "N/A" }); 
            } 
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        // A. Luăm Metadata (Titlu/Durată)
        const metadata = await getYtMetadata(videoUrl);
        
        // B. Luăm Transcriptul
        let originalText = await getOriginalTranscript(videoUrl);
        // Dacă nu găsim transcript, luăm descrierea
        if (!originalText) {
            originalText = metadata.description || "Nu s-a găsit text.";
            originalText = originalText.replace(/https?:\/\/\S+/g, '');
        }

        // C. Traducem
        let translatedText = "Se procesează...";
        if (originalText && originalText.length > 5 && originalText !== "Nu s-a găsit text.") {
            translatedText = await translateSecure(originalText);
        }

        // D. Pregătim răspunsul PENTRU HTML-ul TĂU
        // HTML-ul tău caută specific string-ul "MP4" sau "MP3" în câmpul quality.
        // Aici facem legătura dintre logica veche și designul nou.
        const formats = [
            {
                quality: 'MP4', // AICI E CHEIA: HTML-ul tău caută fix textul ăsta
                url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
                hasAudio: true, hasVideo: true
            },
            {
                quality: 'MP3',
                url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
                hasAudio: true, hasVideo: false
            }
        ];

        // Trimitem JSON-ul
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

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    // Forțăm download-ul în browser
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    // "best" ia automat cea mai bună calitate disponibilă (de obicei 1080p sau 720p)
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

// Ruta Fallback (încarcă index.html dacă intri pe site)
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server Universal Pro pornit pe ${PORT}`);
});