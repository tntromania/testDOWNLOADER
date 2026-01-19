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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';
const RAPIDAPI_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractVideoId(url) {
    if (!url) return null;
    if (url.includes('/shorts/')) return url.split('/shorts/')[1].split(/[?&]/)[0];
    if (url.includes('youtu.be/')) return url.split('youtu.be/')[1].split(/[?&]/)[0];
    const match = url.match(/[?&]v=([^&#]*)/);
    return match ? match[1] : null;
}

app.get('/api/process', async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'ID negăsit' });

    console.log(`--- START PROCESARE: ${videoId} ---`);

    try {
        const headers = { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST };

        // PASUL 1: Luăm Titlul (din /video.php)
        const videoInfo = await axios.get(`https://${RAPIDAPI_HOST}/video.php`, { params: { id: videoId }, headers });
        const title = videoInfo.data.data?.title || "Video YouTube";

        // PASUL 2: Luăm LINK-URILE (din /download.php - conform doc-ului tău)
        console.log(`📡 Cerem link-uri de download pentru ${videoId}...`);
        const downloadRes = await axios.get(`https://${RAPIDAPI_HOST}/download.php`, { params: { id: videoId }, headers });
        
        // Verificăm unde sunt ascunse link-urile în răspuns
        const rawDownloadData = downloadRes.data;
        // Unele API-uri pun datele în .data, altele direct în rădăcină
        const formatList = Array.isArray(rawDownloadData) ? rawDownloadData : (rawDownloadData.data || []);

        let downloadLinks = [];
        formatList.forEach(f => {
            // Căutăm orice câmp care seamănă a URL (url, link, sau download)
            const dUrl = f.url || f.link || f.download;
            if (dUrl) {
                downloadLinks.push({
                    type: (f.type && f.type.includes('audio')) ? 'audio' : 'video',
                    url: dUrl,
                    label: `${f.quality || f.qualityLabel || 'MP4'} (${f.container || f.extension || 'file'})`
                });
            }
        });

        // PASUL 3: Subtitrări & Traducere
        const subRes = await axios.get(`https://${RAPIDAPI_HOST}/subtitle.php`, { params: { id: videoId }, headers }).catch(() => null);
        let transcriptText = "Nu există subtitrări disponibile.";
        let translatedText = "Fără traducere.";

        if (subRes && subRes.data.data) {
            const enSub = subRes.data.data.find(s => s.lang === 'en') || subRes.data.data[0];
            if (enSub?.url) {
                const subFile = await axios.get(enSub.url);
                transcriptText = String(subFile.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

                if (process.env.OPENAI_API_KEY) {
                    const gpt = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [{ role: "system", content: "Rezumat scurt în română." }, { role: "user", content: transcriptText.substring(0, 3000) }]
                    });
                    translatedText = gpt.choices[0].message.content;
                }
            }
        }

        console.log(`✅ GATA. Titlu: ${title} | Link-uri găsite: ${downloadLinks.length}`);

        res.json({
            success: true,
            title: title,
            downloads: downloadLinks.slice(0, 10), // Trimitem primele 10 formate
            transcript: { original: transcriptText.substring(0, 1000), translated: translatedText }
        });

    } catch (error) {
        console.error("❌ EROARE:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server fixat pe portul ${PORT}`));