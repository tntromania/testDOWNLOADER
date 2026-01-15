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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// IMPORTANT: Asigură-te că calea e corectă. Dacă ești pe Windows local, pune calea completă către .exe
// Dacă ești pe server Linux/Coolify, de obicei e 'yt-dlp' sau '/usr/local/bin/yt-dlp'
const YTDLP_PATH = 'yt-dlp'; 

// --- 1. FUNCȚIE SIMPLĂ DE CURĂȚARE VTT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    
    // Eliminăm header-ul WEBVTT
    const lines = vttContent.split('\n');
    const uniqueLines = new Set();
    const result = [];

    for (let line of lines) {
        line = line.trim();
        // Ignorăm metadatele, timestamp-urile și liniile goale
        if (!line || line.includes('-->') || line.startsWith('WEBVTT') || /^\d+$/.test(line)) continue;
        
        // Scoatem tag-urile HTML (<c>, <b> etc)
        line = line.replace(/<[^>]*>/g, '');
        
        // Eliminăm duplicatele consecutive (foarte comun la subtitrările auto)
        if (!uniqueLines.has(line) && line.length > 2) {
            uniqueLines.add(line);
            result.push(line);
        }
    }
    return result.join(' ');
}

// --- 2. EXTRAGERE TRANSCRIPT (METODA SIGURĂ) ---
async function getTranscript(url) {
    const uniqueId = Date.now();
    // Numele de bază pentru fișier (fără extensie)
    const outputBase = path.join(__dirname, `sub_${uniqueId}`);

    return new Promise((resolve) => {
        // Argumente simplificate: "Ia orice subtitrare, convertește în VTT"
        const args = [
            '--skip-download',      // Nu descărca video
            '--write-subs',         // Scrie subtitrări manuale
            '--write-auto-subs',    // Scrie subtitrări automate (dacă nu sunt manuale)
            '--convert-subs', 'vtt',// Convertește totul la format text VTT
            '--output', outputBase, // Numele fișierului
            '--no-check-certificates',
            url
        ];

        const process = spawn(YTDLP_PATH, args);

        process.on('close', () => {
            // CĂUTARE FIȘIER:
            // yt-dlp poate pune sufixe ca .en.vtt, .ro.vtt, .live_chat.vtt etc.
            // Așa că citim folderul și căutăm fișierul care începe cu ID-ul nostru.
            
            try {
                const files = fs.readdirSync(__dirname);
                const subtitleFile = files.find(file => file.startsWith(`sub_${uniqueId}`) && file.endsWith('.vtt'));

                if (subtitleFile) {
                    const fullPath = path.join(__dirname, subtitleFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const cleanText = cleanVttText(content);
                    
                    // Ștergem fișierul temporar
                    fs.unlinkSync(fullPath);
                    
                    resolve(cleanText);
                } else {
                    console.log("❌ Nu s-a generat niciun fișier .vtt");
                    resolve(null);
                }
            } catch (err) {
                console.error("Eroare la citirea fișierului:", err);
                resolve(null);
            }
        });
    });
}

// --- 3. TRADUCERE SIMPLĂ GPT ---
async function translateText(text) {
    if (!text) return "Nu există text de tradus.";
    
    // Limităm la 3000 caractere pentru viteză și costuri
    const chunk = text.substring(0, 3000); 

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Tradu acest text în Română. Fii concis." },
                { "role": "user", "content": chunk }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        return "Eroare la traducere AI.";
    }
}

// --- 4. METADATA (Titlu) ---
async function getTitle(url) {
    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
        let data = '';
        proc.stdout.on('data', d => data += d);
        proc.on('close', () => {
            try { resolve(JSON.parse(data).title); } catch { resolve("Video YouTube"); }
        });
    });
}

// --- ENDPOINTS ---

app.get('/api/download', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`Processing: ${url}`);

    try {
        // 1. Luăm titlul
        const title = await getTitle(url);
        
        // 2. Luăm transcriptul (orice limbă găsește)
        let originalText = await getTranscript(url);
        
        // Fallback dacă chiar nu găsește nimic
        if (!originalText || originalText.length < 5) {
            originalText = "Nu s-au găsit subtitrări pentru acest video (nici automate).";
        }

        // 3. Traducem
        const translatedText = await translateText(originalText);

        res.json({
            status: 'ok',
            data: {
                title: title,
                formats: [
                    { quality: 'Video (MP4)', url: `/api/stream?type=video&url=${encodeURIComponent(url)}` },
                    { quality: 'Audio (MP3)', url: `/api/stream?type=audio&url=${encodeURIComponent(url)}` }
                ],
                transcript: {
                    original: originalText,
                    translated: translatedText
                }
            }
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server simplu pornit pe ${PORT}`));