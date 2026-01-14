const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003;

// --- CONFIGURARE MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// SERVIRE FIȘIERE STATICE
app.use(express.static(path.join(__dirname, 'public')));

// Cheia se ia din variabilele de mediu setate în Coolify
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = 'yt-dlp'; 

// --- 1. DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- 2. CURĂȚARE TEXT (VTT) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        // Eliminăm timestamp-uri, header-uri și linii goale
        if (!line || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('WEBVTT') || line.startsWith('NOTE')) return;
        // Eliminăm tag-uri HTML <c> etc
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 3. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) {
        console.error("Eroare Google Translate:", err.message);
        return text;
    }
}

// --- 4. TRADUCERE GPT ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 4000); // Mărim limita puțin

    console.log("\n🤖 GPT-4o-mini începe traducerea...");

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

// --- 5. LOGICA EXTRAGERE TRANSCRIPT (REPARATĂ) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    // Folosim un prefix clar pentru a găsi fișierul mai ușor
    const outputBase = path.join(__dirname, `temp_${uniqueId}`);

    return new Promise((resolve) => {
        const subProcess = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-auto-sub',
            '--write-sub',
            '--convert-subs', 'vtt',
            '--output', outputBase, // yt-dlp va adăuga sufixe gen .en.vtt sau .ro.vtt
            '--no-check-certificates',
            '--no-warnings', // IMPORTANT: Ascunde erorile care strică procesul
            url
        ]);

        subProcess.on('close', () => {
            // Căutăm orice fișier care începe cu temp_{uniqueId} și se termină în .vtt
            const dir = __dirname;
            const files = fs.readdirSync(dir);
            const vttFile = files.find(f => f.startsWith(`temp_${uniqueId}`) && f.endsWith('.vtt'));

            if (vttFile) {
                const fullPath = path.join(dir, vttFile);
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const clean = cleanVttText(content);
                    fs.unlinkSync(fullPath); // Ștergem fișierul temporar
                    resolve(clean);
                } catch(e) {
                    console.error("Eroare citire VTT:", e);
                    resolve(null);
                }
            } else {
                console.log("❌ Nu s-a găsit niciun fișier .vtt generat.");
                resolve(null);
            }
        });
    });
}

// --- 6. METADATE VIDEO (REPARATĂ) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        // IMPORTANT: Adăugat --no-warnings pentru a primi JSON curat
        const metaProcess = spawn(YTDLP_PATH, [
            '--dump-json', 
            '--no-warnings', 
            '--no-check-certificates', 
            url
        ]);
        
        let buffer = '';
        metaProcess.stdout.on('data', d => buffer += d);
        
        metaProcess.on('close', () => {
            try { 
                const data = JSON.parse(buffer);
                resolve(data); 
            } catch (e) { 
                console.error("Eroare parsare JSON Metadata:", e.message);
                // Returnăm un obiect gol dar valid ca să nu crape frontend-ul
                resolve({ title: "Titlu Indisponibil", duration_string: "N/A", description: "" }); 
            }
        });
    });
}

// --- 7. ENDPOINTS API ---

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`[${platform.toUpperCase()}] Procesare: ${videoUrl}`);

    try {
        // 1. Obținem Metadate
        const metadata = await getYtMetadata(videoUrl);
        
        // 2. Procesăm Transcript (Doar pt YouTube)
        let transcriptData = null;
        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            
            // Dacă nu găsim subtitrare, luăm descrierea (dar doar dacă e lungă)
            if (!originalText && metadata.description && metadata.description.length > 50) {
                console.log("Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description;
            }

            if (originalText) {
                const translatedText = await translateWithGPT(originalText);
                transcriptData = {
                    original: originalText,
                    translated: translatedText
                };
            }
        }

        // Calcul durată afișată
        let displayDuration = metadata.duration_string;
        if (!displayDuration && metadata.duration) {
            const m = Math.floor(metadata.duration / 60);
            const s = metadata.duration % 60;
            displayDuration = `${m}:${s.toString().padStart(2, '0')}`;
        }
        if (!displayDuration) displayDuration = "N/A";

        const formats = [
            { quality: 'MP3', url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'MP4', url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title || "Video Fără Titlu",
                duration: displayDuration,
                formats: formats,
                transcript: transcriptData
            }
        });
    } catch (error) {
        console.error("Eroare CRITICĂ API:", error);
        res.status(500).json({ error: 'Eroare internă server.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    const filename = isAudio ? 'audio.mp3' : 'video.mp4';
    
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    const args = [
        '-o', '-', 
        '--no-check-certificates', 
        '--no-warnings',
        '--force-ipv4', 
        '-f', isAudio ? 'bestaudio' : 'best', 
        url
    ];
    
    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);

    streamProcess.on('error', (err) => {
        console.error("Stream error:", err);
    });
});

// --- 8. RUTA FALLBACK ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 9. PORNIRE SERVER ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server PRO pornit pe portul ${PORT}`);
});