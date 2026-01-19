const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE ---
// Cheia ta hardcodată ca fallback, ca să fim siguri că o ia
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- HELPER: EXTRAGERE ID (SUPORTĂ SHORTS) ---
function extractVideoId(url) {
    if (!url) return null;
    
    // 1. Cazul Shorts (youtube.com/shorts/ID)
    if (url.includes('/shorts/')) {
        const parts = url.split('/shorts/');
        return parts[1].split('?')[0].split('&')[0]; // Luăm ID-ul curat
    }

    // 2. Cazul Youtu.be (youtu.be/ID)
    if (url.includes('youtu.be/')) {
        return url.split('youtu.be/')[1].split('?')[0];
    }

    // 3. Cazul Standard (youtube.com/watch?v=ID)
    const match = url.match(/[?&]v=([^&#]*)/);
    if (match && match[1]) return match[1];

    return null;
}

// --- RUTA PRINCIPALĂ ---
app.get('/api/process', async (req, res) => {
    const { url } = req.query;
    console.log(`\n📥 Request nou pentru: ${url}`);

    const videoId = extractVideoId(url);
    if (!videoId) {
        console.error("❌ ID invalid/nedetectat");
        return res.status(400).json({ error: 'Link invalid. Nu am putut extrage ID-ul.' });
    }

    console.log(`🚀 ID detectat: ${videoId} (Se trimite la API...)`);

    try {
        const headers = {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST
        };

        // Cerem DIRECT endpoint-ul principal /video.php care are de obicei si link-urile
        // Uneori download.php e mai bun, le incercam pe ambele
        const [videoRes, subtitleRes] = await Promise.allSettled([
            axios.get(`https://${RAPIDAPI_HOST}/video.php`, { params: { id: videoId }, headers }),
            axios.get(`https://${RAPIDAPI_HOST}/subtitle.php`, { params: { id: videoId }, headers })
        ]);

        let title = "Video fără titlu";
        let downloadLinks = [];
        let transcriptText = "Nu există subtitrări.";
        let translatedText = "Fără traducere.";

        // --- PROCESARE VIDEO & DOWNLOAD ---
        if (videoRes.status === 'fulfilled') {
            const data = videoRes.value.data;
            console.log("📦 Răspuns Video API:", JSON.stringify(data).substring(0, 200) + "..."); // Log scurt

            // Titlu
            if (data.title) title = data.title;
            else if (data.data && data.data.title) title = data.data.title;

            // Formate
            // API-ul poate returna formatele direct in array sau in .formats
            let formats = [];
            if (Array.isArray(data)) formats = data;
            else if (data.formats) formats = data.formats;
            else if (data.data && data.data.formats) formats = data.data.formats;

            // Extragem MP4
            if (formats.length > 0) {
                // Căutăm cel mai bun video cu sunet
                const bestVideo = formats.find(f => f.quality === '720p' && f.extension === 'mp4') || 
                                  formats.find(f => f.extension === 'mp4');
                
                if (bestVideo) downloadLinks.push({ type: 'video', url: bestVideo.url, label: bestVideo.quality || 'MP4' });

                // Căutăm Audio
                const bestAudio = formats.find(f => f.extension === 'mp3' || f.extension === 'm4a');
                if (bestAudio) downloadLinks.push({ type: 'audio', url: bestAudio.url, label: 'AUDIO' });
            }
        } else {
            console.error("❌ Eroare la Video API:", videoRes.reason.message);
        }

        // --- PROCESARE SUBTITRARE ---
        if (subtitleRes.status === 'fulfilled') {
            const subData = subtitleRes.value.data;
            let subs = [];
            
            if (Array.isArray(subData)) subs = subData;
            else if (subData.data) subs = subData.data;

            // Căutăm engleză sau prima
            const enSub = subs.find(s => s.lang === 'en') || subs[0];
            
            if (enSub && enSub.url) {
                console.log("📥 Descarc subtitrarea de la:", enSub.url);
                try {
                    const textRes = await axios.get(enSub.url);
                    // Curățăm textul (simplu)
                    let raw = typeof textRes.data === 'object' ? JSON.stringify(textRes.data) : textRes.data;
                    
                    // Eliminam tag-uri de timp daca e VTT/SRT
                    transcriptText = raw.replace(/(\d{2}:\d{2}:\d{2}[,.]\d{3} --> \d{2}:\d{2}:\d{2}[,.]\d{3})/g, '')
                                        .replace(/<[^>]*>/g, '')
                                        .replace(/WEBVTT/g, '')
                                        .replace(/^\d+$/gm, '') // linii cu numere
                                        .replace(/\n\s*\n/g, '\n') // linii goale
                                        .trim();

                    // TRADUCERE GPT
                    if (OPENAI_API_KEY) {
                        const gpt = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [
                                { role: "system", content: "Rezumat scurt în română." },
                                { role: "user", content: transcriptText.substring(0, 5000) }
                            ]
                        });
                        translatedText = gpt.choices[0].message.content;
                    }
                } catch (err) {
                    console.error("Eroare download text sub:", err.message);
                }
            }
        }

        console.log(`✅ Finalizat. Titlu: ${title}, Linkuri: ${downloadLinks.length}`);

        res.json({
            success: true,
            title: title,
            downloads: downloadLinks,
            transcript: {
                original: transcriptText.substring(0, 3000),
                translated: translatedText
            }
        });

    } catch (error) {
        console.error("❌ CRITICAL ERROR:", error.message);
        res.status(500).json({ error: "Eroare server internă." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server fixat pentru Shorts pornit pe ${PORT}`);
});