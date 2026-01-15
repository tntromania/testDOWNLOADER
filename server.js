const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();
const PORT = 3003; // Portul setat în Coolify

// --- CONFIGURARE MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE VARIABILE ---
// Cheia OpenAI din mediu sau hardcodată (dacă e nevoie, dar recomand ENV)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'PUNE_CHEIA_AICI_DACA_NU_AI_ENV'; 
const YTDLP_PATH = 'yt-dlp'; // Pe Linux/Coolify este de obicei global

// --- 1. DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- 2. CURĂȚARE TEXT (Versiunea Robustă din Codul Vechi) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();

        // LISTA NEAGRĂ: Eliminăm gunoaiele tehnice
        if (
            !line || 
            line.startsWith('WEBVTT') || 
            line.includes('-->') || 
            /^\d+$/.test(line) ||       
            line.startsWith('Kind:') ||
            line.startsWith('Language:') ||
            line.startsWith('NOTE')
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

// --- 3. EXTRAGERE TRANSCRIPT (Metoda Sigură cu Fișiere Temporare) ---
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

        process.on('close', (code) => {
            // Verificăm variantele posibile de nume generate de yt-dlp
            const possibleFiles = [
                `${outputTemplate}.en.vtt`,
                `${outputTemplate}.en-orig.vtt`
            ];
            
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                try {
                    const content = fs.readFileSync(foundFile, 'utf8');
                    const text = cleanVttText(content);
                    fs.unlinkSync(foundFile); // Curățăm după noi
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

// --- 4. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("🔄 Fallback: Google Translate...");
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        return "Traducere indisponibilă momentan.";
    }
}

// --- 5. TRADUCERE GPT (Principală) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    // Dacă nu avem cheie API, folosim direct Google
    if (!OPENAI_API_KEY || OPENAI_API_KEY.includes('PUNE_CHEIA')) {
        return await translateWithGoogle(text);
    }

    const textToTranslate = text.substring(0, 4000); 
    console.log("\n🤖 GPT-4o-mini începe traducerea...");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Ești un traducător expert. Traduce textul în limba Română. Păstrează sensul dar fă-l să sune natural." },
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

// --- 6. METADATE VIDEO ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => {
            try { 
                const data = JSON.parse(buffer);
                resolve(data); 
            } catch (e) { 
                resolve({ title: "Video Necunoscut", duration_string: "N/A", description: "" }); 
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
        // A. Metadate
        const metadata = await getYtMetadata(videoUrl);
        
        // B. Transcript (Doar YouTube)
        let transcriptData = null;
        if (platform === 'youtube') {
            let originalText = await getOriginalTranscript(videoUrl);
            
            // Fallback la descriere
            if (!originalText && metadata.description && metadata.description.length > 50) {
                console.log("Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description.replace(/https?:\/\/\S+/g, ''); // Scoatem linkuri
            }

            if (originalText) {
                const translatedText = await translateWithGPT(originalText);
                transcriptData = {
                    original: originalText,
                    translated: translatedText
                };
            }
        }

        // C. Formate (AICI ERA PROBLEMA - Trebuie să generăm lista completă)
        // Frontend-ul caută: f.quality === selectedQuality + 'p' && f.format === 'mp4'
        const qualities = ['360', '480', '720', '1080', '1440', '2160'];
        const formats = [];

        // Generăm opțiuni video pentru fiecare calitate
        qualities.forEach(q => {
            formats.push({
                quality: q + 'p', 
                format: 'mp4',
                hasVideo: true,
                hasAudio: true,
                url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` // Cale relativă pt Coolify
            });
        });

        // Generăm opțiunea audio
        formats.push({
            quality: '192', 
            format: 'mp3',
            hasVideo: false,
            hasAudio: true,
            url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}`
        });

        // D. Trimitem răspunsul
        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string || "N/A",
                formats: formats, // Acum conține lista completă pe care o așteaptă index.html
                transcript: transcriptData
            }
        });

    } catch (error) {
        console.error("Eroare Server:", error);
        res.status(500).json({ error: 'Eroare internă server.' });
    }
});

// Endpoint Streaming
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    
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
});

// Fallback pentru React/HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server PRO (GPT + Formate Fixe) pornit pe ${PORT}`);
});