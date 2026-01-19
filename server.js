const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Servim folderul public pentru html/css/imagini
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE API (CEL BUN) ---
const RAPIDAPI_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'social-media-video-downloader.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Asigură-te că ai cheia în .env sau hardcoded aici pt test
});

// Cache Memorie (URL -> Date) pentru viteză maximă
const memoryCache = new Map();

// --- HELPER: Extragere ID YouTube (Shorts & Normal) ---
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// --- HELPER: Traducere AI ---
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (lipsește cheia OpenAI).";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un expert în sinteze. Rezumă textul următor în limba română, folosind bullet points clare." },
                { role: "user", content: text }
            ],
            max_tokens: 700,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare la generarea rezumatului."; }
}

// --- RUTA 1: ANALIZĂ (Se apelează automat la paste) ---
app.get('/api/resolve', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    // 1. Verificăm Cache-ul (Instant)
    if (memoryCache.has(url)) {
        console.log('⚡ Serving from Cache');
        return res.json(memoryCache.get(url).info);
    }

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Link YouTube invalid' });

    console.log(`🔍 Fetching details for ID: ${videoId}`);

    try {
        // 2. Apelăm API-ul TĂU VALID (Axios request)
        const options = {
            method: 'GET',
            url: `https://${RAPIDAPI_HOST}/youtube/v3/video/details`,
            params: {
                videoId: videoId,
                renderableFormats: '720p,highres', // Formate gata de download
                urlAccess: 'proxied',              // Link-uri directe (fără expirare rapidă)
                getTranscript: 'true'              // Luăm și textul
            },
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            }
        };

        const response = await axios.request(options);
        const data = response.data;

        // 3. Procesăm Transcriptul (Background)
        let transcriptObj = null;
        if (data.transcript && data.transcript.content) {
            const originalText = data.transcript.content;
            
            // Setăm textul original
            transcriptObj = { original: originalText, translated: "Se generează traducerea..." };

            // Pornim AI-ul în fundal (nu blocăm răspunsul către user)
            processWithGPT(originalText).then(translated => {
                const cached = memoryCache.get(url);
                if (cached) cached.info.transcript.translated = translated;
            });
        }

        // 4. Pregătim obiectul Info pentru Frontend
        const info = {
            title: data.title || "YouTube Video",
            duration: data.lengthSeconds ? `${Math.floor(data.lengthSeconds / 60)}:${data.lengthSeconds % 60}` : "--:--",
            transcript: transcriptObj
        };

        // 5. Salvăm în Cache TOT (Info + Link-uri de download)
        // API-ul returnează link-uri în `streamingData.formats` (video+audio) și `adaptiveFormats` (separat)
        const formats = data.streamingData ? (data.streamingData.formats || []) : [];
        const adaptives = data.streamingData ? (data.streamingData.adaptiveFormats || []) : [];

        memoryCache.set(url, {
            info: info,
            formats: formats,
            adaptives: adaptives
        });

        res.json(info);

    } catch (error) {
        console.error("❌ API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Eroare la comunicarea cu serverul YouTube.' });
    }
});

// --- RUTA 2: DOWNLOAD (Instant din Cache) ---
app.get('/api/download', (req, res) => {
    const { url, type, quality } = req.query; // type: 'video'/'audio', quality: '1080', '720'

    if (!memoryCache.has(url)) {
        return res.status(404).send("Sesiune expirată. Te rog analizează link-ul din nou.");
    }

    const cachedData = memoryCache.get(url);
    let finalLink = null;

    if (type === 'audio') {
        // Căutăm cel mai bun audio (m4a/mp3)
        const audio = cachedData.adaptives.find(f => f.mimeType.includes('audio'));
        if (audio) finalLink = audio.url;
    } else {
        // Căutăm Video (Mp4 cu sunet preferabil)
        // Încercăm să găsim calitatea cerută în formatele 'muxed' (video+sunet)
        let video = cachedData.formats.find(f => f.qualityLabel && f.qualityLabel.includes(quality));
        
        // Dacă nu găsim exact calitatea (ex: 1080p e des doar adaptive), luăm cel mai bun format disponibil
        if (!video) video = cachedData.formats[0]; 

        // Fallback: Dacă nici în formats nu e nimic bun, luăm din adaptive (video fără sunet e mai bun decât nimic)
        if (!video) {
            video = cachedData.adaptives.find(f => f.qualityLabel && f.qualityLabel.includes(quality) && f.mimeType.includes('video'));
        }

        if (video) finalLink = video.url;
    }

    if (finalLink) {
        res.redirect(finalLink);
    } else {
        res.status(404).send("Nu am găsit un link direct pentru acest format.");
    }
});

// --- RUTA 3: Polling Traducere ---
app.get('/api/transcript', (req, res) => {
    const { url } = req.query;
    if (memoryCache.has(url)) {
        res.json(memoryCache.get(url).info.transcript);
    } else {
        res.json(null);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 YouTube Downloader Engine STARTED on port ${PORT}`);
});