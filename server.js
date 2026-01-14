const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // Asigură-te că ai dat npm install axios
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CHEIA TA OPENAI ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {

    console.warn("⚠️ OPENAI_API_KEY nu este setată în variabilele de mediu!");

}

// --- CONFIG LINUX ---
const YTDLP_PATH = 'yt-dlp';

// --- 1. Funcție: CURĂȚARE TEXT (Scoate Kind, Language, Timpii) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();

        // LISTA NEAGRĂ: Dacă linia conține astea, o aruncăm
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
        ) {
            return;
        }

        // Scoatem tag-urile HTML (<c.color...>)
        line = line.replace(/<[^>]*>/g, '');

        // Păstrăm linia doar dacă e text real și nu e duplicat
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });

    return cleanText.join(' ');
}

// --- 2. Funcție: Descarcă Transcriptul (Focus pe ENgleză) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve, reject) => {
        const args = [
            '--skip-download',
            '--write-sub', '--write-auto-sub', // Cere subtitrări (manuale sau automate)
            '--sub-lang', 'en',                // Țintește specific Engleza (cea mai sigură)
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ];

        const process = spawn(YTDLP_PATH, args);

        process.on('close', (code) => {
            // Verificăm variantele posibile de nume pe care le dă YouTube
            const possibleFiles = [
                `${outputTemplate}.en.vtt`,      // Manuală
                `${outputTemplate}.en-orig.vtt`  // Automată
            ];
            
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                try {
                    const content = fs.readFileSync(foundFile, 'utf8');
                    const text = cleanVttText(content);
                    fs.unlinkSync(foundFile); // Ștergem fișierul după citire
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

// --- 3. Funcție: Traducere ---
async function translateSecure(text) {
    if (!text || text.length < 5) return "Nu există text suficient.";
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        return "Traducere momentan indisponibilă.";
    }
}

// --- 4. Funcție: Metadata ---
function getYtMetadata(url) {
    return new Promise((resolve, reject) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => { 
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                // Dacă crapă JSON-ul, dăm un titlu generic
                resolve({ title: "YouTube Video", description: "", duration_string: "" }); 
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
        // A. Luăm Metadata (Titlu, Descriere)
        const metadata = await getYtMetadata(videoUrl);
        
        // B. Luăm Transcriptul
        console.log("-> Caut transcript...");
        let originalText = await getOriginalTranscript(videoUrl);
        
        // Dacă nu găsim subtitrare, folosim descrierea (dar curată)
        if (!originalText) {
            console.log("-> Nu am găsit subtitrare, folosesc descrierea.");
            originalText = metadata.description || "Nu s-a găsit text.";
            // Scoatem link-urile din descriere
            originalText = originalText.replace(/https?:\/\/\S+/g, '');
        }

        // C. Traducem
        let translatedText = "Se procesează...";
        if (originalText && originalText.length > 5 && originalText !== "Nu s-a găsit text.") {
            translatedText = await translateSecure(originalText);
        } else {
            translatedText = "Nu există conținut text de tradus.";
        }

        // D. Pregătim răspunsul
        const qualities = ['360', '480', '720', '1080'];
        const formats = [];
        qualities.forEach(q => {
            formats.push({
                quality: q + 'p', format: 'mp4',
                url: `api/stream?url=${encodeURIComponent(videoUrl)}&type=video`,
                hasAudio: true, hasVideo: true
            });
        });
        formats.push({
            quality: '192', format: 'mp3',
            url: `api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`,
            hasAudio: true, hasVideo: false
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: {
                    original: originalText.substring(0, 2000) + "...", 
                    translated: translatedText
                }
            }
        });
        console.log(`-> Gata!`);

    } catch (error) {
        console.error("Eroare:", error.message);
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

    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

app.listen(PORT, () => {
    console.log(`Server REVENIT LA CLASIC (EN + CLEAN) pornit pe ${PORT}`);
});