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
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; // Instalat via Docker
const RAPIDAPI_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'youtube-info-download-api.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Asigură-te că ai asta în env variables în Coolify
});

// Cache simplu pentru Transcript/Titlu (să nu cerem de 2 ori pentru același link)
const metadataCache = new Map();

// --- FUNCȚII HELPER ---

// 1. Argumente light pentru yt-dlp (Doar text/metadata)
function getMetadataArgs() {
    return [
        '--no-warnings',
        '--no-check-certificates',
        '--dump-json', // Vrem doar JSON cu info, nu download
        '--skip-download',
        '--extractor-args', 'youtube:player_client=android',
    ];
}

// 2. Argumente pentru Subtitrări
function getSubtitleArgs(outputBase) {
    return [
        '--no-warnings',
        '--no-check-certificates',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-lang', 'en,ro,.*',
        '--sub-format', 'vtt',
        '--output', outputBase,
    ];
}

// 3. Curățare Text VTT
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

// 4. Extragere Transcript Local (pe VPS)
async function getTranscript(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/sub_${Date.now()}_${Math.random().toString(36).substr(7)}`;
        const args = [...getSubtitleArgs(outputBase), url];
        
        const process = spawn(YTDLP_PATH, args);
        
        process.on('close', (code) => {
            const dir = '/tmp';
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const files = fs.readdirSync(dir);
                const subFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));
                
                if (subFile) {
                    const content = fs.readFileSync(path.join(dir, subFile), 'utf8');
                    fs.unlinkSync(path.join(dir, subFile)); // Curățăm
                    resolve(cleanVttText(content));
                } else {
                    resolve(null);
                }
            } catch (e) { resolve(null); }
        });
    });
}

// 5. Extragere Titlu (Metadata) Local
async function getLocalMetadata(url) {
    return new Promise((resolve, reject) => {
        const p = spawn(YTDLP_PATH, [...getMetadataArgs(), url]);
        let data = '';
        p.stdout.on('data', d => data += d);
        p.on('close', () => {
            try {
                const json = JSON.parse(data);
                resolve({ title: json.title, duration: json.duration_string });
            } catch (e) {
                // Dacă eșuează local, returnăm un generic
                resolve({ title: "Video YouTube (Titlu indisponibil)", duration: "--:--" });
            }
        });
    });
}

// 6. Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "No API Key.";
    if (!text || text.length < 50) return "Text prea scurt.";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Fă un rezumat scurt, clar, cu liniuțe, în limba română." },
                { role: "user", content: text }
            ],
            max_tokens: 800,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare GPT."; }
}

// --- ENDPOINTS ---

// A. Endpoint Inițial: Returnează Titlu, Rezumat și LISTA DE BUTOANE
// NU cheltuie bani pe RapidAPI încă.
app.get('/api/info', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`🔍 Info request: ${url}`);

    // Verificăm cache
    if (metadataCache.has(url)) return res.json(metadataCache.get(url));

    try {
        // 1. Luăm metadata local și transcriptul în paralel
        const [meta, rawTranscript] = await Promise.all([
            getLocalMetadata(url),
            getTranscript(url)
        ]);

        // 2. Procesăm GPT dacă avem text
        let transcriptData = null;
        if (rawTranscript) {
            const summary = await processWithGPT(rawTranscript);
            transcriptData = { original: rawTranscript, translated: summary };
        }

        // 3. Construim lista de formate DISPONIBILE (Hardcoded pentru că API-ul le suportă pe toate)
        // Link-urile de aici vor duce către endpoint-ul nostru /api/convert care face plata la RapidAPI
        const formats = [
            { quality: 'Audio MP3', format: 'mp3', type: 'audio', url: `/api/convert?url=${encodeURIComponent(url)}&type=audio&quality=128` },
            { quality: 'Video 360p', format: 'mp4', type: 'video', url: `/api/convert?url=${encodeURIComponent(url)}&type=video&quality=360p` },
            { quality: 'Video 720p', format: 'mp4', type: 'video', url: `/api/convert?url=${encodeURIComponent(url)}&type=video&quality=720p` },
            { quality: 'Video 1080p', format: 'mp4', type: 'video', url: `/api/convert?url=${encodeURIComponent(url)}&type=video&quality=1080p` }
        ];

        const response = {
            title: meta.title,
            duration: meta.duration,
            transcript: transcriptData,
            formats: formats
        };

        metadataCache.set(url, response); // Salvăm în cache
        res.json(response);

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Eroare server' });
    }
});

// B. Endpoint Convert: Aici se face plata către RapidAPI
// Se apelează doar când utilizatorul dă click pe un buton
app.get('/api/convert', async (req, res) => {
    const { url, type, quality } = req.query; // type: video/audio, quality: 1080p/128
    
    console.log(`💰 RapidAPI Call: ${type} - ${quality} for ${url}`);

    try {
        // Configurăm parametrii pentru RapidAPI
        const params = {
            url: url,
            format: type === 'audio' ? 'mp3' : 'mp4', 
        };

        if (type === 'audio') {
            params.audio_quality = '128'; // Standard MP3
        } else {
            // RapidAPI așteaptă quality de genul '1080p', '720p' etc.
            params.video_quality = quality || '720p'; 
        }

        // Apelul propriu-zis
        const apiResponse = await axios.get(`https://${RAPIDAPI_HOST}/ajax/download.php`, {
            params: params,
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        });

        const data = apiResponse.data;

        // Verificăm dacă RapidAPI ne-a dat link-ul
        if (data && (data.url || data.link)) {
            const downloadLink = data.url || data.link;
            
            // REDIRECȚIONĂM utilizatorul direct către link-ul generat de API
            // Astfel download-ul pornește instant în browser
            return res.redirect(downloadLink);
        } else {
            throw new Error('API nu a returnat un link valid.');
        }

    } catch (error) {
        console.error('❌ RapidAPI Error:', error.response ? error.response.data : error.message);
        res.status(500).send("Eroare la generarea link-ului de download (RapidAPI).");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server RapidAPI pornit pe portul ${PORT}`);
});