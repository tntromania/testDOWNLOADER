const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// --- CONFIGURARE ---
const RAPIDAPI_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'social-media-video-downloader.p.rapidapi.com';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const metadataCache = new Map();

// --- HELPERE ---

// Extrage ID-ul video-ului din orice link YouTube (Normal sau Shorts)
function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/user\/\S+|\/ytscreeningroom\?v=|\/sandalsResorts#\w\/\w\/.*\/))([^\/&]{10,12})/);
    return match ? match[1] : null;
}

// Rezumat AI
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Fără cheie API setată.";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un asistent care rezumă transcrieri video în limba română. Fii concis." },
                { role: "user", content: `Rezumă acest text: ${text}` }
            ],
            max_tokens: 500,
        });
        return completion.choices[0].message.content;
    } catch (e) { return "Eroare la generarea rezumatului AI."; }
}

// --- RUTE API ---

// 1. INFO & TRANSCRIPT
app.get('/api/info', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`🔍 Info Request: ${rawUrl}`);

    // Verificăm cache-ul
    if (metadataCache.has(rawUrl)) return res.json(metadataCache.get(rawUrl));

    const videoId = extractVideoId(rawUrl);
    if (!videoId) return res.status(400).json({ error: 'Link YouTube invalid' });

    try {
        // Apelăm endpoint-ul tău exact cu parametrii din cURL
        const response = await axios.get(`https://${RAPIDAPI_HOST}/youtube/v3/video/details`, {
            params: {
                videoId: videoId,
                renderableFormats: '720p,1080p,highres', // Cerem formatele bune
                urlAccess: 'proxied',
                getTranscript: 'true' // Cerem și transcriptul direct!
            },
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        });

        const data = response.data;

        // Prelucrăm datele
        const title = data.title || "Video YouTube";
        const duration = data.lengthSeconds ? `${Math.floor(data.lengthSeconds / 60)}:${data.lengthSeconds % 60}` : "--:--";
        
        // Transcript
        let transcriptData = null;
        if (data.transcript && data.transcript.content) {
            const originalText = data.transcript.content; 
            const summary = await processWithGPT(originalText);
            transcriptData = { original: originalText, translated: summary };
        }

        const result = {
            title: title,
            duration: duration,
            transcript: transcriptData,
            // Salvăm datele brute pentru pasul de download ca să nu mai facem request
            rawFormats: data.streamingData ? data.streamingData : null 
        };

        metadataCache.set(rawUrl, result);
        res.json(result);

    } catch (error) {
        console.error("❌ API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Nu am putut obține datele video-ului.' });
    }
});

// 2. DOWNLOAD (Folosește datele din Info sau face request nou)
app.get('/api/convert', async (req, res) => {
    const { url, type, quality } = req.query; // quality ex: '1080p'
    const videoId = extractVideoId(url);
    
    console.log(`🚀 Download Request: ${url} [${type}]`);

    try {
        let videoData;

        // Încercăm să luăm datele din cache (ca să nu plătești API call dublu)
        if (metadataCache.has(url) && metadataCache.get(url).rawFormats) {
            console.log("⚡ Folosim date din cache.");
            videoData = metadataCache.get(url).rawFormats;
        } else {
            // Dacă nu e în cache, facem request din nou
            console.log("🔄 Fetching fresh data...");
            const response = await axios.get(`https://${RAPIDAPI_HOST}/youtube/v3/video/details`, {
                params: { videoId: videoId, urlAccess: 'proxied', getTranscript: 'false' },
                headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }
            });
            videoData = response.data.streamingData;
        }

        if (!videoData) return res.status(404).send("Nu am găsit link-uri de download.");

        let downloadLink = null;

        // LOGICA DE EXTRACTION A LINK-ULUI
        if (type === 'audio') {
            // Căutăm doar audio (mimeType audio/mp4 sau audio/webm)
            const formats = [...(videoData.adaptiveFormats || []), ...(videoData.formats || [])];
            const audio = formats.find(f => f.mimeType.includes('audio'));
            downloadLink = audio ? audio.url : null;
        } else {
            // Căutăm video cu sunet (formats) sau adaptiv
            // API-ul returnează de obicei link-uri directe în `formats` (muxed) sau `adaptiveFormats`
            const formats = videoData.formats || []; // Formate cu sunet inclus
            
            // Încercăm să găsim calitatea cerută (ex: 1080p)
            // Notă: Youtube dă 1080p de obicei doar ca video-only (adaptive), 
            // dar acest API cu 'proxied' s-ar putea să le combine.
            // Pentru siguranță luăm cel mai bun format cu sunet (720p de obicei).
            
            // Căutăm exact calitatea sau cea mai bună disponibilă
            let bestVideo = formats.find(f => f.qualityLabel && f.qualityLabel.includes(quality)) ||
                            formats.find(f => f.qualityLabel === '720p') ||
                            formats[0];
            
            if (bestVideo) downloadLink = bestVideo.url;
            
            // Dacă tot nu avem link, căutăm în adaptive (poate fi fără sunet, dar e mai bine decât nimic)
            if (!downloadLink && videoData.adaptiveFormats) {
                 const bestAdaptive = videoData.adaptiveFormats.find(f => f.qualityLabel && f.qualityLabel.includes(quality));
                 if(bestAdaptive) downloadLink = bestAdaptive.url;
            }
        }

        if (downloadLink) {
            return res.redirect(downloadLink);
        } else {
            res.status(404).send("Nu am putut genera link-ul pentru formatul cerut.");
        }

    } catch (error) {
        console.error("❌ Convert Error:", error.message);
        res.status(500).send("Eroare server.");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server FINAL (Endpoint: youtube/v3/video/details) pornit pe portul ${PORT}`);
});