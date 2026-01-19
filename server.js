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
const RAPIDAPI_HOST = 'youtube-mp41.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const metadataCache = new Map();

// --- HELPERE ---
function sanitizeUrl(url) {
    if (!url) return "";
    if (url.includes('/shorts/')) {
        const parts = url.split('/shorts/');
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

// 1. HTML Title Scraper (Fallback)
async function getTitleFromHTML(url) {
    try {
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = response.data;
        const match = html.match(/<title>(.*?)<\/title>/);
        if (match && match[1]) return match[1].replace(' - YouTube', '').trim();
        return "Video (Titlu indisponibil)";
    } catch (e) { return "Video (Titlu indisponibil)"; }
}

// 2. Metadata Local
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
                const backupTitle = await getTitleFromHTML(url);
                resolve({ title: backupTitle, duration: "--:--" });
            }
        });
    });
}

// 3. Transcript Local
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

app.get('/api/info', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL lipsă' });
    const url = sanitizeUrl(rawUrl);

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

// --- LOGICA NOUĂ: API DISCOVERY ---

async function startConversion(url, format) {
    // LISTA DE ENDPOINT-URI POSIBILE (Le încercăm pe rând)
    const possibleEndpoints = [
        `/api/v1/init`,
        `/api/v1/convert`,
        `/api/v1/dloadUrl`,
        `/api/v1/create`
    ];

    for (const path of possibleEndpoints) {
        try {
            console.log(`📡 Încerc endpoint: ${path}`);
            const response = await axios.get(`https://${RAPIDAPI_HOST}${path}`, {
                params: { url: url, format: format || 'mp4' },
                headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }
            });

            const data = response.data;
            const id = data.id || data.hash || (data.status === 'processing' ? data.job_id : null);

            if (id) {
                console.log(`✅ BINGO! Endpoint corect: ${path} | ID: ${id}`);
                return id;
            }
        } catch (error) {
            // Ignorăm erorile 404 și trecem la următorul endpoint
            if (error.response && error.response.status !== 404) {
                console.log(`⚠️ Eroare pe ${path}: ${error.message}`);
            }
        }
    }
    return null;
}

async function pollProgress(id) {
    let attempts = 0;
    const maxAttempts = 60; 

    while (attempts < maxAttempts) {
        try {
            const response = await axios.get(`https://${RAPIDAPI_HOST}/api/v1/progress`, {
                params: { id: id },
                headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }
            });

            const data = response.data;
            
            if (data.status === 'success' || data.status === 'finished') {
                console.log(`✅ GATA! URL: ${data.url}`);
                return data.url;
            }
            if (data.status === 'fail') {
                return null;
            }
            await new Promise(r => setTimeout(r, 2000));
            attempts++;
        } catch (error) {
            await new Promise(r => setTimeout(r, 2000));
            attempts++;
        }
    }
    return null;
}

app.get('/api/convert', async (req, res) => {
    const { url, type } = req.query;
    const cleanUrl = sanitizeUrl(url);
    const format = type === 'audio' ? 'mp3' : 'mp4';

    try {
        const jobId = await startConversion(cleanUrl, format);
        if (!jobId) return res.status(500).send("Nu am găsit endpoint-ul API corect sau API-ul e down.");

        const downloadLink = await pollProgress(jobId);

        if (downloadLink) {
            return res.redirect(downloadLink);
        } else {
            return res.status(500).send("Timeout.");
        }
    } catch (error) {
        res.status(500).send("Eroare internă.");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server FINAL (Auto-Discovery) pornit pe portul ${PORT}`);
});