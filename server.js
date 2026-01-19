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

// --- HELPER FUNCTIONS ---

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

// 1. Încercare Extragere Titlu via HTML (Backup când yt-dlp e blocat)
async function getTitleFromHTML(url) {
    try {
        // Simulăm un browser real
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = response.data;
        // Căutăm tag-ul <title>
        const match = html.match(/<title>(.*?)<\/title>/);
        if (match && match[1]) {
            return match[1].replace(' - YouTube', '').replace('on TikTok', '').trim();
        }
        return "Video (Titlu indisponibil)";
    } catch (e) {
        return "Video (Titlu indisponibil)";
    }
}

// 2. Extragere Titlu via yt-dlp
async function getLocalMetadata(url) {
    return new Promise((resolve) => {
        const args = [
            '--no-warnings', '--no-check-certificates', '--dump-json', '--skip-download',
            '--extractor-args', 'youtube:player_client=android',
            url
        ];
        const p = spawn(YTDLP_PATH, args);
        let data = '';
        p.stdout.on('data', d => data += d);
        p.on('close', async () => {
            try {
                const json = JSON.parse(data);
                resolve({ title: json.title, duration: json.duration_string });
            } catch (e) {
                // Dacă yt-dlp eșuează, încercăm metoda HTML Scraper
                console.log('⚠️ yt-dlp blocat pentru metadate. Încerc HTML scraper...');
                const backupTitle = await getTitleFromHTML(url);
                resolve({ title: backupTitle, duration: "--:--" });
            }
        });
    });
}

// 3. Extragere Transcript
async function getTranscript(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/sub_${Date.now()}_${Math.random().toString(36).substr(7)}`;
        const args = [
            '--no-warnings', '--no-check-certificates', '--skip-download',
            '--write-subs', '--write-auto-subs', '--sub-lang', 'en,ro,.*',
            '--sub-format', 'vtt', '--output', outputBase,
            url
        ];
        
        const process = spawn(YTDLP_PATH, args);
        
        process.on('close', (code) => {
            const dir = '/tmp';
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const files = fs.readdirSync(dir);
                const subFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));
                
                if (subFile) {
                    const content = fs.readFileSync(path.join(dir, subFile), 'utf8');
                    fs.unlinkSync(path.join(dir, subFile));
                    resolve(cleanVttText(content));
                } else {
                    resolve(null);
                }
            } catch (e) { resolve(null); }
        });
    });
}

async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Fără cheie API.";
    if (!text || text.length < 50) return "Text prea scurt.";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Rezumat scurt în română." },
                { role: "user", content: text }
            ],
            max_tokens: 500,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare GPT."; }
}

// --- ENDPOINTS ---

app.get('/api/info', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`🔍 Info request: ${url}`);
    if (metadataCache.has(url)) return res.json(metadataCache.get(url));

    try {
        const [meta, rawTranscript] = await Promise.all([
            getLocalMetadata(url),
            getTranscript(url)
        ]);

        let transcriptData = null;
        if (rawTranscript) {
            const summary = await processWithGPT(rawTranscript);
            transcriptData = { original: rawTranscript, translated: summary };
        }

        const response = {
            title: meta.title,
            duration: meta.duration,
            transcript: transcriptData
        };

        metadataCache.set(url, response);
        res.json(response);

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Eroare server' });
    }
});

// FUNCȚIE RECURSIVĂ DE RETRY PENTRU API
async function fetchFromRapidAPI(url, type, quality) {
    const qualitiesToTry = [quality];
    
    // Dacă utilizatorul vrea 1080p, pregătim fallback la 720p și 360p
    if (quality === '1080p') qualitiesToTry.push('720p', '480p', '360p');
    if (quality === '720p') qualitiesToTry.push('480p', '360p');

    for (const q of qualitiesToTry) {
        try {
            console.log(`⏳ Trying RapidAPI with Quality: ${q}...`);
            const params = { url: url, format: type === 'audio' ? 'mp3' : 'mp4' };
            
            if (type === 'audio') params.audio_quality = '128';
            else params.video_quality = q;

            const response = await axios.get(`https://${RAPIDAPI_HOST}/ajax/download.php`, {
                params: params,
                headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }
            });

            const data = response.data;
            // Verificăm dacă API-ul a dat succes
            if (data && (data.url || data.link) && data.success !== false) {
                console.log(`✅ Success with quality: ${q}`);
                return data.url || data.link;
            } else {
                console.log(`⚠️ Quality ${q} failed: ${JSON.stringify(data)}`);
            }
        } catch (err) {
            console.log(`⚠️ Network Error on ${q}`);
        }
    }
    return null;
}

app.get('/api/convert', async (req, res) => {
    const { url, type, quality } = req.query;
    console.log(`💰 RapidAPI Call: ${type} - ${quality} for ${url}`);

    try {
        // Folosim funcția cu retry automat
        const downloadLink = await fetchFromRapidAPI(url, type, quality);

        if (downloadLink) {
            return res.redirect(downloadLink);
        } else {
            // Dacă tot nu merge, trimitem un fișier text de eroare ca să nu crape browserul
            res.status(404).send('Ne pare rau. Nu am putut genera link-ul pentru acest video (Formate indisponibile).');
        }

    } catch (error) {
        console.error('❌ Server Error:', error.message);
        res.status(500).send("Eroare interna.");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server RapidAPI cu FALLBACK pornit pe portul ${PORT}`);
});