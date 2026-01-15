const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());

// Pe Coolify/Linux, yt-dlp trebuie să fie instalat în sistem (PATH)
const YTDLP_CMD = 'yt-dlp'; 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- 1. CONFIGURARE ANTI-BLOCK ---
function getYtArgs() {
    return [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--sleep-requests', '1'
    ];
}

// --- 2. CURĂȚARE VTT ---
function cleanVtt(text) {
    if (!text) return "";
    const lines = text.split('\n');
    const uniqueLines = new Set();
    const result = [];

    lines.forEach(line => {
        line = line.trim();
        // Ignoră metadata, timestamp-uri și linii goale
        if (!line || line.includes('-->') || line.startsWith('WEBVTT') || /^\d+$/.test(line) || line.startsWith('Kind:') || line.startsWith('Language:')) return;
        
        line = line.replace(/<[^>]*>/g, ''); // Scoate tag-uri HTML
        
        if (!uniqueLines.has(line) && line.length > 1) {
            uniqueLines.add(line);
            result.push(line);
        }
    });
    return result.join(' ');
}

// --- 3. EXTRAGERE TRANSCRIPT (Metoda Fișier Temporar) ---
async function getTranscript(url) {
    const id = Date.now();
    const tempFile = path.join(__dirname, `sub_${id}`);
    
    // Comandă specifică pentru extragere subtitrare EN
    const args = [
        ...getYtArgs(),
        '--skip-download',
        '--write-sub', '--write-auto-sub',
        '--sub-lang', 'en',
        '--convert-subs', 'vtt',
        '--output', tempFile,
        url
    ];

    return new Promise(resolve => {
        const proc = spawn(YTDLP_CMD, args);
        
        proc.on('close', () => {
            // Verifică variantele de nume posibile
            const files = [`${tempFile}.en.vtt`, `${tempFile}.en-orig.vtt`, `${tempFile}.en-auto.vtt`];
            const found = files.find(f => fs.existsSync(f));

            if (found) {
                try {
                    const content = fs.readFileSync(found, 'utf8');
                    fs.unlinkSync(found); // Șterge fișierul imediat
                    resolve(cleanVtt(content));
                } catch (e) { resolve(null); }
            } else {
                resolve(null);
            }
        });
    });
}

// --- 4. TRADUCERE GPT ---
async function translateGPT(text) {
    if (!text || !OPENAI_API_KEY) return null;
    try {
        const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Traducere în română. Doar textul, fără explicații." },
                { role: "user", content: text.substring(0, 5000) }
            ]
        }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
        return resp.data.choices[0].message.content;
    } catch (e) {
        console.error("Eroare GPT:", e.message);
        return "Eroare la traducere.";
    }
}

// --- 5. METADATA ---
function getMetadata(url) {
    return new Promise(resolve => {
        let data = '';
        const proc = spawn(YTDLP_CMD, [...getYtArgs(), '--dump-json', url]);
        proc.stdout.on('data', d => data += d);
        proc.on('close', () => {
            try { resolve(JSON.parse(data)); } 
            catch { resolve({ title: "Video", description: "" }); }
        });
    });
}

// --- ROUTES ---

app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`Processing: ${url}`);

    try {
        // 1. Metadata & Transcript
        const meta = await getMetadata(url);
        let text = await getTranscript(url);

        // Fallback la descriere dacă nu e transcript
        if (!text) text = (meta.description || "").replace(/https?:\/\/\S+/g, '');

        // 2. Traducere
        const translated = (text && text.length > 5) ? await translateGPT(text) : "Lipsă text.";

        // 3. Link-uri stream
        const host = `${req.protocol}://${req.get('host')}`;
        const makeLink = (type) => `${host}/api/stream?url=${encodeURIComponent(url)}&type=${type}`;

        res.json({
            status: 'ok',
            data: {
                title: meta.title,
                formats: [
                    { quality: 'Video (Best)', url: makeLink('video') },
                    { quality: 'Audio (MP3)', url: makeLink('audio') }
                ],
                transcript: {
                    original: text ? text.substring(0, 3000) : null,
                    translated: translated
                }
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    const isAudio = type === 'audio';
    
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);

    const args = [...getYtArgs(), '-o', '-', '-f', isAudio ? 'bestaudio' : 'best', url];
    const proc = spawn(YTDLP_CMD, args);
    
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`Coolify Server running on port ${PORT}`));