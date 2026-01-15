const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// AM SCOS IMPORTUL PENTRU GOOGLE TRANSLATE

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());

// --- CHEIA TA OPENAI ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = path.join(__dirname, 'yt-dlp.exe');

// --- DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
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
        if (!line || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('WEBVTT')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE GPT CU STREAMING (MATRIX STYLE) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    const textToTranslate = text.substring(0, 3000);

    console.log("\n🤖 GPT-4o-mini începe traducerea:");
    console.log("------------------------------------------------");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3,
            stream: true
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        let fullTranslation = "";

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                
                for (const line of lines) {
                    const message = line.replace(/^data: /, '');
                    if (message === '[DONE]') return; 
                    
                    try {
                        const parsed = JSON.parse(message);
                        const content = parsed.choices[0].delta.content;
                        if (content) {
                            process.stdout.write(content); 
                            fullTranslation += content;
                        }
                    } catch (error) {}
                }
            });

            response.data.on('end', () => {
                console.log("\n------------------------------------------------");
                console.log("✅ Gata! Traducerea completă salvată.");
                resolve(fullTranslation);
            });

            response.data.on('error', (err) => reject(err));
        });

    } catch (error) {
        console.warn("\n⚠️ Eroare OpenAI Stream:", error.message);
        // Fallback: Returnăm textul original dacă GPT eșuează, deoarece Google Translate a fost scos.
        return `(Traducere eșuată - Text Original): ${text}`; 
    }
}

// --- 3. LOGICA DOWNLOADER ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        process.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                const content = fs.readFileSync(foundFile, 'utf8');
                const clean = cleanVttText(content);
                try { fs.unlinkSync(foundFile); } catch(e){}
                resolve(clean);
            } else {
                resolve(null);
            }
        });
    });
}

function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => {
            try { resolve(JSON.parse(buffer)); } catch (e) { resolve({ title: "Video", description: "" }); }
        });
    });
}

// --- ENDPOINTS ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`\n[${platform.toUpperCase()}] Procesez: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        // PROCESĂM TRANSCRIPTUL DOAR PENTRU YOUTUBE
        if (platform === 'youtube') {
            console.log("📝 YouTube detectat - extrag transcript...");
            let originalText = await getOriginalTranscript(videoUrl);

            if (!originalText) {
                console.log("Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description || "Niciun text găsit.";
            }

            const translatedText = await translateWithGPT(originalText);
            
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        } else {
            console.log(`⏩ ${platform} - skip transcript (doar download)`);
        }

        // --- DINAMIC HOST URL ---
        // Folosim req.headers.host pentru a genera link-ul corect indiferent dacă ești pe localhost sau IP public
        const protocol = req.protocol; 
        const host = req.headers.host; // Ex: localhost:3003 sau 192.168.1.X:3003 sau domeniu.ro

        const formats = [
            { quality: 'Video HD (MP4)', url: `${protocol}://${host}/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'Audio Only (MP3)', url: `${protocol}://${host}/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: transcriptData // Null pentru non-YouTube
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
});

// Ascultă pe toate interfețele de rețea (0.0.0.0) pentru acces din extern
app.listen(PORT, '0.0.0.0', () => {
    console.log(`📥 Downloader Pro (Host Mode) pornit pe portul ${PORT}`);
    console.log(`🌍 Accesibil extern via IP-ul serverului.`);
});