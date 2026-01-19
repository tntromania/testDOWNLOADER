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
const RAPIDAPI_HOST = 'youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- RUTA PRINCIPALĂ ---
app.get('/api/process', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Lipsește URL-ul.' });

    // Extragem ID-ul video-ului
    const videoIdMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    if (!videoId) return res.status(400).json({ error: 'Link invalid.' });

    console.log(`🚀 Procesez ID: ${videoId}`);

    try {
        // PASUL 1: Obținem Detalii Video (Titlu, Durată, Thumb)
        const infoOptions = {
            method: 'GET',
            url: `https://${RAPIDAPI_HOST}/get-video-info/${videoId}`,
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            }
        };
        
        const infoRes = await axios.request(infoOptions);
        const infoData = infoRes.data;

        // PASUL 2: Obținem Lista de Limbi (Ca să știm ce cerem)
        const langOptions = {
            method: 'GET',
            url: `https://${RAPIDAPI_HOST}/language-list/${videoId}`,
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            }
        };
        
        let targetLang = 'en'; // Default
        try {
            const langRes = await axios.request(langOptions);
            // Căutăm engleza sau prima disponibilă
            if (langRes.data && Array.isArray(langRes.data)) {
                const hasEn = langRes.data.find(l => l.languageCode === 'en');
                if (!hasEn && langRes.data.length > 0) {
                    targetLang = langRes.data[0].languageCode;
                }
            }
        } catch (e) {
            console.log("⚠️ Nu am putut lua lista de limbi, încerc 'en' default.");
        }

        // PASUL 3: Descărcăm Transcriptul (JSON)
        // Folosim endpoint-ul /download-json/{videoId} cu parametrul language
        const subOptions = {
            method: 'GET',
            url: `https://${RAPIDAPI_HOST}/download-json/${videoId}`,
            params: { language: targetLang },
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            }
        };

        let originalText = "Transcript indisponibil.";
        let translatedText = "Nu am putut traduce.";

        try {
            const subRes = await axios.request(subOptions);
            const subData = subRes.data;

            // API-ul returnează un Array de obiecte: [{start, dur, text}, ...]
            // Noi vrem doar textul lipit pentru traducere.
            if (Array.isArray(subData)) {
                originalText = subData.map(item => item.text).join(' ');
            }

            // PASUL 4: Traducere cu GPT
            if (OPENAI_API_KEY && originalText.length > 5) {
                const gpt = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "Ești un traducător expert. Tradu următorul transcript în limba română. Păstrează sensul și fii concis." },
                        { role: "user", content: originalText }
                    ]
                });
                translatedText = gpt.choices[0].message.content;
            }

        } catch (subError) {
            console.error("Eroare la transcript:", subError.message);
            if(subError.response && subError.response.status === 404) {
                originalText = "Acest video nu are subtitrări disponibile.";
            }
        }

        // RĂSPUNS FINAL
        res.json({
            success: true,
            info: {
                title: infoData.title || "Video Fără Titlu",
                thumb: infoData.thumbnail ? infoData.thumbnail[infoData.thumbnail.length-1].url : "",
                duration: infoData.lengthSeconds ? `${Math.floor(infoData.lengthSeconds / 60)}:${infoData.lengthSeconds % 60}` : "N/A"
            },
            transcript: {
                original: originalText,
                translated: translatedText
            }
        });

    } catch (error) {
        console.error("❌ Eroare Generală:", error.message);
        res.status(500).json({ error: "Eroare la procesare API." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Captions pornit pe portul ${PORT}`);
});