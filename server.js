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

// --- CHEIA TA OPENAI ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    console.error("❌ ATENȚIE: OPENAI_API_KEY nu este setată în variabilele de mediu!");
} else {
    console.log("✅ OPENAI_API_KEY detectată (lungime:", OPENAI_API_KEY.length, "caractere)");
}

// --- PATH YT-DLP (fără .exe pentru Linux) ---
const YTDLP_PATH = 'yt-dlp';

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

// --- 2. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("\n🔄 Trec pe Google Translate (Gratuit)...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) {
        console.error("❌ Eroare Google Translate:", err.message);
        return text;
    }
}

// --- 3. TRADUCERE GPT CU STREAMING (MATRIX STYLE) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) {
        console.log("⚠️ Text prea scurt pentru traducere");
        return "Nu există suficient text.";
    }
    
    if (!OPENAI_API_KEY) {
        console.error("❌ OPENAI_API_KEY lipsește! Folosesc Google Translate...");
        return await translateWithGoogle(text);
    }
    
    const textToTranslate = text.substring(0, 3000);

    console.log("\n🤖 GPT-4o-mini începe traducerea:");
    console.log("📝 Text de tradus (lungime):", textToTranslate.length, "caractere");
    console.log("🔑 API Key (primele 10 char):", OPENAI_API_KEY.substring(0, 10) + "...");
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
                    } catch (error) {
                        // Erori de parsing sunt normale în streaming
                    }
                }
            });

            response.data.on('end', () => {
                console.log("\n------------------------------------------------");
                console.log("✅ Gata! Traducerea completă salvată.");
                resolve(fullTranslation);
            });

            response.data.on('error', (err) => {
                console.error("❌ Eroare stream:", err.message);
                reject(err);
            });
        });

    } catch (error) {
        console.error("\n❌ EROARE OPENAI:");
        console.error("   Status:", error.response?.status);
        console.error("   Message:", error.message);
        console.error("   Response:", error.response?.data);
        
        if (error.response?.status === 401) {
            console.error("\n⚠️ Cheie API invalidă! Verifică OPENAI_API_KEY în Coolify.");
        }
        
        console.log("\n🔄 Fallback la Google Translate...");
        return await translateWithGoogle(text);
    }
}

// --- 4. LOGICA DOWNLOADER ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const ytdlpProcess = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        ytdlpProcess.on('close', () => {
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
        const ytdlpProcess = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        ytdlpProcess.stdout.on('data', d => buffer += d);
        ytdlpProcess.on('close', () => {
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
                console.log("⚠️ Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description || "Niciun text găsit.";
            } else {
                console.log("✅ Subtitrare găsită:", originalText.length, "caractere");
            }

            // Traducere cu GPT (cu fallback automat la Google)
            const translatedText = await translateWithGPT(originalText);
            
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        } else {
            console.log(`⏩ ${platform} - skip transcript (doar download)`);
        }

        // Format pentru frontend
        const formats = [
            { 
                quality: 'MP4', 
                format: 'mp4',
                hasVideo: true,
                hasAudio: true,
                url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` 
            },
            { 
                quality: 'MP3', 
                format: 'mp3',
                hasVideo: false,
                hasAudio: true,
                url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` 
            }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: transcriptData
            }
        });

    } catch (error) {
        console.error("❌ Eroare în /api/download:", error);
        res.status(500).json({ error: 'Eroare internă: ' + error.message });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
});

// Fallback pentru SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📥 Downloader Pro (Smart GPT) pornit pe portul ${PORT}`);
    console.log(`🔑 OpenAI API: ${OPENAI_API_KEY ? '✅ Configurată' : '❌ LIPSEȘTE'}`);
    console.log(`${'='.repeat(50)}\n`);
});