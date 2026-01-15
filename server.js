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
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- VALIDARE PLATFORMĂ ---
function detectPlatform(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
    if (urlLower.includes('tiktok.com')) return 'tiktok';
    if (urlLower.includes('instagram.com')) return 'instagram';
    if (urlLower.includes('facebook.com') || urlLower.includes('fb.watch') || urlLower.includes('fb.com')) return 'facebook';
    return 'unknown';
}

// --- 1. CURĂȚARE TEXT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || 
            line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Tip:') || 
            line.startsWith('Limbă:') || line.startsWith('Style:')) {
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

// --- 2. TRADUCERE GPT-4o-mini CU LOGS ---
async function translateWithAI(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    console.log("\n--- [AI DEBUG] Începe procesul de traducere ---");
    console.log(`[AI DEBUG] Lungime text original: ${text.length} caractere`);

    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul în limba Română, natural și fluent." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });

            const translated = response.data.choices[0].message.content;
            
            console.log("--- [AI DEBUG] Răspuns GPT primit cu succes ---");
            console.log("[AI DEBUG] Fragment traducere:", translated.substring(0, 150) + "...");
            return translated;

        } catch (e) { 
            console.error("--- [AI DEBUG] Eroare OpenAI API ---", e.message);
            console.warn("Fallback la Google Translate...");
        }
    }

    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        console.log("--- [AI DEBUG] Traducere Google Translate finalizată ---");
        return res.text;
    } catch (err) { 
        console.error("--- [AI DEBUG] Toate metodele de traducere au eșuat ---");
        return "Traducere indisponibilă."; 
    }
}

// --- 3. EXTRAGERE TRANSCRIPT ÎMBUNĂTĂȚITĂ (pentru domeniu/server) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`); // fisier temporar

    console.log(`\n--- [TRANSCRIPT DEBUG] Se caută transcript pentru: ${url} ---`);

    // Argumente yt-dlp
    const args = [
        '--skip-download',
        '--write-auto-sub',   // subtitrări automate
        '--write-sub',        // subtitrări create de autor
        '--sub-lang', 'en.*,en', // orice variantă de engleză
        '--convert-subs', 'vtt',
        '--output', outputTemplate,
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        url
    ];

    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, args);

        let stderrData = '';
        proc.stderr.on('data', (d) => stderrData += d.toString());

        proc.on('close', () => {
            const files = fs.readdirSync(__dirname);
            const foundFile = files.find(f => f.startsWith(`trans_${uniqueId}`) && f.endsWith('.vtt'));

            if (foundFile) {
                const filePath = path.join(__dirname, foundFile);
                console.log(`[TRANSCRIPT DEBUG] Fișier găsit: ${foundFile}`);

                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const text = cleanVttText(content);

                    // Ștergem fișierul după citire
                    fs.unlinkSync(filePath);

                    console.log(`[TRANSCRIPT DEBUG] Text extras (primele 200 caractere):`, text.substring(0, 200));
                    resolve(text.length > 0 ? text : null);

                } catch (e) {
                    console.error("[TRANSCRIPT ERROR] Citire fișier vtt:", e.message);
                    resolve(null);
                }

            } else {
                console.warn("[TRANSCRIPT DEBUG] Nu s-a găsit niciun fișier de subtitrare.");
                if (stderrData) console.warn("[yt-dlp STDERR]:", stderrData.substring(0, 300));
                resolve(null);
            }
        });
    });
}

// --- 4. METADATA ---
async function getYtMetadata(url) {
    try {
        const oembed = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
        return { title: oembed.data.title };
    } catch (e) {
        return new Promise((resolve) => {
            const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
            let buf = '';
            proc.stdout.on('data', d => buf += d);
            proc.on('close', () => {
                try { 
                    const data = JSON.parse(buf);
                    resolve({ title: data.title || "Video" }); 
                } catch (e) { 
                    resolve({ title: "Video" }); 
                }
            });
        });
    }
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    const requestedPlatform = req.query.platform || 'youtube';
    
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const detectedPlatform = detectPlatform(videoUrl);
    
    // VALIDARE: Verifică dacă URL-ul corespunde platformei selectate
    if (detectedPlatform !== requestedPlatform) {
        return res.status(400).json({ 
            error: `URL incorect! Ai selectat ${requestedPlatform.toUpperCase()} dar link-ul este de la ${detectedPlatform.toUpperCase()}.` 
        });
    }

    try {
        const metadata = await getYtMetadata(videoUrl);
        
        // TRANSCRIPT DOAR PENTRU YOUTUBE
        let transcriptData = null;
        if (detectedPlatform === 'youtube') {
            const originalText = await getOriginalTranscript(videoUrl);
            if (originalText && originalText.length > 10) {
                const translatedText = await translateWithAI(originalText);
                transcriptData = {
                    original: originalText.substring(0, 3000),
                    translated: translatedText
                };
            }
        }

        const formats = ['360', '480', '720', '1080'].map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ 
            quality: '192', 
            format: 'mp3', 
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` 
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                platform: detectedPlatform,
                formats: formats,
                transcript: transcriptData || { original: null, translated: null }
            }
        });
    } catch (e) { 
        console.error('Error:', e);
        res.status(500).json({ error: 'Eroare procesare.' }); 
    }
});

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const isAudio = req.query.type === 'audio';
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = ['-o', '-', '--no-warnings', '--force-ipv4', '-f', isAudio ? 'bestaudio' : 'best', req.query.url];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server pornit pe ${PORT}`));