const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Servim fișierele statice (CSS, JS, Imagini) din folderul public
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE ---
const RAPIDAPI_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'social-media-video-downloader.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Cache ca să fie instant (URL -> Date Video)
const memoryCache = new Map();

// --- HELPER: Extragere ID YouTube ---
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// --- HELPER: Rezumat GPT ---
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Fără cheie API.";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un traducător expert. Fă un rezumat scurt, structurat cu liniuțe, în limba română." },
                { role: "user", content: text }
            ],
            max_tokens: 600,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare GPT."; }
}

// --- 1. PRELOAD DATA (Se apelează automat când pui link-ul) ---
app.get('/api/resolve', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`🔍 Analizez: ${url}`);

    if (memoryCache.has(url)) {
        console.log('⚡ Din Cache!');
        return res.json(memoryCache.get(url).info);
    }

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Nu am putut extrage ID-ul video.' });

    try {
        // Apelăm API-ul tău VALID
        const response = await axios.get(`https://${RAPIDAPI_HOST}/youtube/v3/video/details`, {
            params: {
                videoId: videoId,
                renderableFormats: '360p,480p,720p,1080p,highres',
                urlAccess: 'proxied', // Important pentru link-uri directe
                getTranscript: 'true'
            },
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        });

        const data = response.data;
        const streamingData = data.streamingData || {};
        
        // Procesare Transcript
        let transcriptObj = null;
        if (data.transcript && data.transcript.content) {
            const originalText = data.transcript.content;
            // Pornim GPT asincron, nu blocăm răspunsul
            processWithGPT(originalText).then(translated => {
                // Actualizăm cache-ul când e gata traducerea
                const cached = memoryCache.get(url);
                if(cached) cached.info.transcript = { original: originalText, translated: translated };
            });
            
            // Trimitem textul original imediat
            transcriptObj = { original: originalText, translated: "Se generează traducerea..." };
        }

        // Informațiile de trimis la frontend
        const info = {
            title: data.title || "Video fără titlu",
            duration: data.lengthSeconds ? `${Math.floor(data.lengthSeconds/60)}:${data.lengthSeconds%60}` : "--:--",
            transcript: transcriptObj,
            ready: true
        };

        // Salvăm TOT (Info + Formate) în cache
        memoryCache.set(url, {
            info: info,
            formats: streamingData.formats || [], // Video cu sunet
            adaptive: streamingData.adaptiveFormats || [] // Video/Audio separat
        });

        res.json(info);

    } catch (error) {
        console.error("❌ API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Eroare la comunicarea cu RapidAPI.' });
    }
});

// --- 2. GET TRANSCRIPT (Polling pentru traducere) ---
app.get('/api/transcript', (req, res) => {
    const { url } = req.query;
    if (memoryCache.has(url)) {
        res.json(memoryCache.get(url).info.transcript);
    } else {
        res.json(null);
    }
});

// --- 3. DOWNLOAD INSTANT (Din Cache) ---
app.get('/api/download', (req, res) => {
    const { url, type, quality } = req.query; // quality: '1080', '720' etc.
    
    console.log(`📥 Download req: ${type} ${quality}p`);

    if (!memoryCache.has(url)) {
        return res.status(404).send("Link expirat. Te rog dă refresh și analizează din nou.");
    }

    const data = memoryCache.get(url);
    let finalLink = null;

    if (type === 'audio') {
        // Căutăm m4a/mp3 în adaptive
        const audio = data.adaptive.find(f => f.mimeType.includes('audio'));
        if (audio) finalLink = audio.url;
    } else {
        // VIDEO
        // Încercăm să găsim un fișier complet (Video+Audio) în 'formats'
        let video = data.formats.find(f => f.qualityLabel && f.qualityLabel.includes(quality));
        
        // Dacă nu găsim exact calitatea, luăm cea mai bună disponibilă (de obicei 720p)
        if (!video) video = data.formats.find(f => f.qualityLabel === '720p');
        if (!video && data.formats.length > 0) video = data.formats[0];

        if (video) finalLink = video.url;
    }

    if (finalLink) {
        res.redirect(finalLink);
    } else {
        res.status(404).send("Formatul cerut nu este disponibil pentru acest video.");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server PRO pornit pe portul ${PORT}`);
});