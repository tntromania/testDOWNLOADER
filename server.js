const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// --- CONFIGURARE ---
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; 
const RAPIDAPI_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'youtube-info-download-api.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const metadataCache = new Map();

// --- HELPER: Curățare URL (Transformă Shorts în Watch) ---
function sanitizeUrl(url) {
    if (!url) return "";
    // Dacă e link de shorts, îl facem link normal
    if (url.includes('/shorts/')) {
        const parts = url.split('/shorts/');
        // Luăm ID-ul video-ului (până la primul semn de întrebare dacă există)
        const videoId = parts[1].split('?')[0];
        return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
}

function cleanVttText(vttContent) {
    const lines = vttContent.split('\n');
    const uniqueLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line)) return;
        const cleanLine = line.replace(/<[^>]*>/g, '').trim();
        if (cleanLine) uniqueLines.add(cleanLine);
    });
    return Array.from(uniqueLines).join(' ');
}

// 1. Extragere Titlu via HTML (Backup)
async function getTitleFromHTML(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });
        const html = response.data;
        const match = html.match(/<title>(.*?)<\/title>/);
        if (match && match[1]) return match[1].replace(' - YouTube', '').replace('on TikTok', '').trim();
        return "Video (Titlu indisponibil)";
    } catch (e) { return "Video (Titlu indisponibil)"; }
}

// 2. Extragere Titlu via yt-dlp
async function getLocalMetadata(url) {
    return new Promise((resolve) => {
        const args = ['--dump-json', '--skip-download', '--extractor-args', 'youtube:player_client=android', url];
        const p = spawn(YTDLP_PATH, args);
        let data = '';
        p.stdout.on('data', d => data += d);
        p.on('close', async () => {
            try {
                const json = JSON.parse(data);
                resolve({ title: json.title, duration: json.duration_string });
            } catch (e) {
                console.log('⚠️ yt-dlp blocat. Folosim HTML fallback.');
                const backupTitle = await getTitleFromHTML(url);
                resolve({ title: backupTitle, duration: "--:--" });
            }
        });
    });
}

// 3. Transcript
async function getTranscript(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/sub_${Date.now()}_${Math.random().toString(36).substr(7)}`;
        const args = [
            '--skip-download', '--write-subs', '--write-auto-subs', '--sub-lang', 'en,ro,.*',
            '--sub-format', 'vtt', '--output', outputBase, url
        ];
        const process = spawn(YTDLP_PATH, args);
        process.on('close', () => {
            const dir = '/tmp';
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const files = fs.readdirSync(dir);
                const subFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));
                if (subFile) {
                    const content = fs.readFileSync(path.join(dir, subFile), 'utf8');
                    fs.unlinkSync(path.join(dir, subFile));
                    resolve(cleanVttText(content));
                } else { resolve(null); }
            } catch (e) { resolve(null); }
        });
    });
}

async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Fără cheie API.";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Rezumat scurt." }, { role: "user", content: text }],
            max_tokens: 500,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare GPT."; }
}

// --- ENDPOINTS ---

app.get('/api/info', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL lipsă' });

    // Curățăm URL-ul pentru Shorts
    const url = sanitizeUrl(rawUrl);
    console.log(`🔍 Info request (Sanitized): ${url}`);

    if (metadataCache.has(url)) return res.json(metadataCache.get(url));

    try {
        const [meta, rawTranscript] = await Promise.all([getLocalMetadata(url), getTranscript(url)]);
        let transcriptData = null;
        if (rawTranscript) {
            const summary = await processWithGPT(rawTranscript);
            transcriptData = { original: rawTranscript, translated: summary };
        }
        const response = { title: meta.title, duration: meta.duration, transcript: transcriptData };
        metadataCache.set(url, response);
        res.json(response);
    } catch (e) { res.status(500).json({ error: 'Eroare server' }); }
});

// FUNCȚIE RETRY CU DEBUGGING COMPLET
async function fetchFromRapidAPI(url, type, quality) {
    // Ordinea de încercare
    let qualitiesToTry = [quality];
    if (quality === '1080p') qualitiesToTry = ['1080p', '720p', '480p']; 
    if (quality === '720p') qualitiesToTry = ['720p', '480p'];

    for (const q of qualitiesToTry) {
        try {
            console.log(`⏳ [RapidAPI] Cerere calitate: ${q} | URL: ${url}`);
            
            const params = { 
                url: url, 
                format: type === 'audio' ? 'mp3' : 'mp4' 
            };
            
            // Logica specifică API-ului
            if (type === 'audio') {
                params.audio_quality = '128';
            } else {
                params.video_quality = q; // API-ul așteaptă '1080p', '720p' etc.
            }

            const response = await axios.get(`https://${RAPIDAPI_HOST}/ajax/download.php`, {
                params: params,
                headers: { 
                    'x-rapidapi-host': RAPIDAPI_HOST, 
                    'x-rapidapi-key': RAPIDAPI_KEY 
                }
            });

            const data = response.data;
            
            // VERIFICĂM RĂSPUNSUL
            if (data && (data.url || data.link) && data.success !== false) {
                console.log(`✅ [RapidAPI] SUCCES! Link primit: ${data.url || data.link}`);
                return data.url || data.link;
            } else {
                console.log(`❌ [RapidAPI] Eșec logic:`, JSON.stringify(data));
            }

        } catch (err) {
            // AICI VEDEM DE CE CRAPĂ
            if (err.response) {
                // Serverul a răspuns cu un cod de eroare (4xx, 5xx)
                console.log(`🔥 [RapidAPI] Eroare HTTP ${err.response.status}:`, err.response.data);
            } else if (err.request) {
                // Nu s-a primit niciun răspuns
                console.log(`🔥 [RapidAPI] Timeout / No Response.`);
            } else {
                // Eroare de configurare
                console.log(`🔥 [RapidAPI] Eroare Config: ${err.message}`);
            }
        }
    }
    return null;
}

app.get('/api/convert', async (req, res) => {
    const { url, type, quality } = req.query;
    
    // Curățăm URL-ul și aici
    const cleanUrl = sanitizeUrl(url);
    console.log(`💰 Convert Request: ${type} - ${quality} -> ${cleanUrl}`);

    try {
        const downloadLink = await fetchFromRapidAPI(cleanUrl, type, quality);

        if (downloadLink) {
            return res.redirect(downloadLink);
        } else {
            res.status(404).send('RapidAPI nu a putut genera link-ul. Verifică log-urile serverului.');
        }
    } catch (error) {
        res.status(500).send("Eroare interna.");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server DEBUG pornit pe portul ${PORT}`);
});