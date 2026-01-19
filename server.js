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
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
// API-ul NOU cerut de tine
const RAPIDAPI_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- HELPERE ---

// Extrage ID-ul corect (suportă Shorts, Watch, Mobile)
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// Curăță textul din subtitrări (scoate timestamp-uri dacă e cazul)
function cleanText(text) {
    // Dacă e XML/HTML simplu, scoatem tag-urile
    return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- RUTA PRINCIPALĂ DE PROCESARE ---
app.get('/api/process', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Lipsește URL-ul.' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Link invalid.' });

    console.log(`🚀 Start analiză ID: ${videoId}`);

    try {
        // --- PASUL 1: CERERI PARALELE CĂTRE RAPIDAPI (Viteză Maximă) ---
        // Cerem Info, Download Links și Subtitrări în același timp
        
        const headers = {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST
        };

        const [infoRes, downloadRes, subRes] = await Promise.allSettled([
            axios.get(`https://${RAPIDAPI_HOST}/video.php`, { params: { id: videoId }, headers }),
            axios.get(`https://${RAPIDAPI_HOST}/download.php`, { params: { id: videoId }, headers }),
            axios.get(`https://${RAPIDAPI_HOST}/subtitle.php`, { params: { id: videoId }, headers })
        ]);

        // --- PASUL 2: PROCESARE VIDEO INFO & DOWNLOAD LINKS ---
        let title = "Video YouTube";
        let downloadLinks = [];

        // Procesare Info
        if (infoRes.status === 'fulfilled' && infoRes.value.data) {
            title = infoRes.value.data.title || title;
        }

        // Procesare Link-uri Download
        if (downloadRes.status === 'fulfilled' && Array.isArray(downloadRes.value.data)) {
            // API-ul returnează un array de formate. Le sortăm să luăm cea mai bună calitate cu sunet.
            // Căutăm formate care au 'video' și 'audio' (sau presupunem că mp4 are ambele)
            const formats = downloadRes.value.data;
            
            // Extragem Video (MP4) - Căutăm 1080p, 720p
            const videoFormat = formats.find(f => f.quality === '1080p' && f.extension === 'mp4') ||
                                formats.find(f => f.quality === '720p' && f.extension === 'mp4') ||
                                formats.find(f => f.extension === 'mp4'); // Fallback

            // Extragem Audio (MP3/M4A)
            const audioFormat = formats.find(f => f.extension === 'mp3' || f.extension === 'm4a');

            if (videoFormat) downloadLinks.push({ type: 'video', url: videoFormat.url, quality: videoFormat.quality });
            if (audioFormat) downloadLinks.push({ type: 'audio', url: audioFormat.url, quality: 'Audio' });
        }

        // --- PASUL 3: PROCESARE TRANSCRIPT & TRADUCERE ---
        let originalText = "Nu există subtitrări disponibile.";
        let translatedText = "";

        if (subRes.status === 'fulfilled' && Array.isArray(subRes.value.data)) {
            // Căutăm limba engleză ('en')
            const subs = subRes.value.data;
            const enSub = subs.find(s => s.lang === 'en') || subs[0]; // Fallback la prima limbă

            if (enSub && enSub.url) {
                try {
                    // Descărcăm conținutul text al subtitrării
                    console.log("📥 Descarc subtitrarea de la:", enSub.url);
                    const textResponse = await axios.get(enSub.url);
                    // Curățăm textul (uneori e JSON, alteori XML/VTT)
                    const rawData = textResponse.data;
                    
                    if (typeof rawData === 'object') {
                        // Dacă e JSON (bazat pe doc-ul tău)
                        // Uneori e array de obiecte {start, dur, text}
                        /* Verificăm structura JSON din doc */
                        originalText = JSON.stringify(rawData); // Temporar, să vedem structura
                        if (Array.isArray(rawData)) {
                             originalText = rawData.map(item => item.text).join(' ');
                        }
                    } else {
                        // E string (VTT/XML)
                        originalText = cleanText(rawData);
                    }

                    // TRADUCERE GPT
                    if (OPENAI_API_KEY && originalText.length > 10) {
                        const gpt = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [
                                { role: "system", content: "Fă un rezumat clar în limba română al acestui text." },
                                { role: "user", content: originalText.substring(0, 15000) } // Limităm lungimea
                            ]
                        });
                        translatedText = gpt.choices[0].message.content;
                    }

                } catch (err) {
                    console.error("Eroare la fetch text subtitrare:", err.message);
                }
            }
        }

        // --- RĂSPUNS FINAL ---
        res.json({
            success: true,
            title: title,
            downloads: downloadLinks,
            transcript: {
                original: originalText.substring(0, 5000) + (originalText.length>5000?"...":""), // Nu trimitem romanul întreg
                translated: translatedText
            }
        });

    } catch (error) {
        console.error("❌ Eroare generală:", error.message);
        res.status(500).json({ error: "Eroare la procesare." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 YouTube Turbo Server pornit pe portul ${PORT}`);
});