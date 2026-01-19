const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE ---
// Cheile vor fi setate în Coolify la Environment Variables
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'youtube-mp41.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- HELPER: POLLING (Codul tău integrat în logică) ---
async function pollProgress(id) {
    let attempts = 0;
    while (attempts < 30) { // Încearcă timp de 60 secunde
        try {
            // AICI E CODUL TĂU PENTRU PROGRESS
            const options = {
                method: 'GET',
                url: `https://${RAPIDAPI_HOST}/api/v1/progress`,
                params: { id: id },
                headers: {
                    'x-rapidapi-key': RAPIDAPI_KEY,
                    'x-rapidapi-host': RAPIDAPI_HOST
                }
            };
            
            const response = await axios.request(options);
            const data = response.data;
            
            console.log(`📡 Status polling (${id}):`, data.status);

            if (data.status === 'success' && data.url) {
                return data.url; // Avem link-ul!
            }
            if (data.status === 'fail') {
                return null;
            }
        } catch (e) {
            console.error("Eroare polling:", e.message);
        }
        
        // Așteptăm 2 secunde între verificări
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    return null;
}

// --- RUTA PRINCIPALĂ ---
app.get('/api/process', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Lipsește URL-ul' });

    console.log(`🚀 Start procesare: ${url}`);

    try {
        // PASUL 1: Start Download (Obținem ID-ul)
        const initOptions = {
            method: 'POST',
            url: `https://${RAPIDAPI_HOST}/api/v1/url`,
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            },
            data: { url: url }
        };

        const initRes = await axios.request(initOptions);
        const jobId = initRes.data.id;

        if (!jobId) throw new Error("Nu am primit ID de la API.");

        // PASUL 2: Așteptăm să fie gata (Polling)
        const downloadUrl = await pollProgress(jobId);

        // PASUL 3: Extragem Transcriptul (Library separat pt siguranță)
        let originalText = "Transcript indisponibil.";
        let translatedText = "Nu am putut traduce.";

        try {
            const transcriptItems = await YoutubeTranscript.fetchTranscript(url, { lang: 'en' }); // încearcă engleză
            originalText = transcriptItems.map(t => t.text).join(' ');
            
            // PASUL 4: Traducere cu GPT-4o-mini
            if (OPENAI_API_KEY) {
                const gpt = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "Tradu acest text în română. Fii concis." },
                        { role: "user", content: originalText }
                    ]
                });
                translatedText = gpt.choices[0].message.content;
            }
        } catch (err) {
            console.log("⚠️ Fără transcript:", err.message);
        }

        // Răspuns final
        res.json({
            success: true,
            videoUrl: downloadUrl,
            transcript: {
                original: originalText,
                translated: translatedText
            }
        });

    } catch (error) {
        console.error("❌ EROARE SERVER:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Servește frontend-ul
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server pornit pe portul ${PORT}`);
});