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

    console.log(`\n--- PROCESARE VIDEO: ${videoId} ---`);

    try {
        const headers = { 
            'X-RapidAPI-Key': RAPIDAPI_KEY, 
            'X-RapidAPI-Host': RAPIDAPI_HOST 
        };

        // Cerem Info (care conține și download-urile) și Subtitrările separat
        const [videoRes, subtitleRes] = await Promise.allSettled([
            axios.get(`https://${RAPIDAPI_HOST}/video.php`, { params: { id: videoId }, headers }),
            axios.get(`https://${RAPIDAPI_HOST}/subtitle.php`, { params: { id: videoId }, headers })
        ]);

        let title = "Video YouTube";
        let downloadLinks = [];
        let transcriptText = "Nu există subtitrări disponibile.";
        let translatedText = "Fără traducere.";

        // 1. PROCESARE VIDEO & DOWNLOADS
        if (videoRes.status === 'fulfilled') {
            const apiFullResponse = videoRes.value.data;
            const videoData = apiFullResponse.data || {};
            
            title = videoData.title || title;

            // Colectăm toate sursele posibile de link-uri (combinăm formats cu adaptive_formats)
            const allFormats = [
                ...(videoData.formats || []),
                ...(videoData.adaptive_formats || [])
            ];

            console.log(`Am găsit ${allFormats.length} formate în total.`);

            allFormats.forEach(f => {
                if (f.url) {
                    const isVideo = f.type && f.type.includes('video') || f.container === 'mp4';
                    const isAudio = f.type && f.type.includes('audio') || f.extension === 'm4a' || f.extension === 'mp3';

                    if (isVideo) {
                        downloadLinks.push({ 
                            type: 'video', 
                            url: f.url, 
                            label: `VIDEO ${f.quality || f.qualityLabel || 'MP4'}` 
                        });
                    } else if (isAudio) {
                        downloadLinks.push({ 
                            type: 'audio', 
                            url: f.url, 
                            label: 'AUDIO (MP3/M4A)' 
                        });
                    }
                }
            });

            // Eliminăm duplicatele de URL
            downloadLinks = downloadLinks.filter((v, i, a) => a.findIndex(t => (t.url === v.url)) === i);
        }

        // 2. PROCESARE SUBTITRĂRI
        if (subtitleRes.status === 'fulfilled') {
            const subtitleData = subtitleRes.value.data.data || [];
            if (Array.isArray(subtitleData) && subtitleData.length > 0) {
                // Căutăm Engleză, dacă nu, luăm prima disponibilă
                const chosenSub = subtitleData.find(s => s.lang === 'en') || subtitleData[0];
                
                if (chosenSub && chosenSub.url) {
                    try {
                        const subContent = await axios.get(chosenSub.url);
                        let raw = typeof subContent.data === 'string' ? subContent.data : JSON.stringify(subContent.data);
                        
                        // Curățăm textul de mizerii XML/VTT/Timestamp-uri
                        transcriptText = raw
                            .replace(/<[^>]*>/g, ' ')
                            .replace(/WEBVTT/g, '')
                            .replace(/\d+:\d+:\d+\.\d+ --> \d+:\d+:\d+\.\d+/g, '')
                            .replace(/\s+/g, ' ')
                            .trim();

                        // TRADUCERE GPT-4o-mini
                        if (process.env.OPENAI_API_KEY && transcriptText.length > 20) {
                            const completion = await openai.chat.completions.create({
                                model: "gpt-4o-mini",
                                messages: [
                                    { role: "system", content: "Ești un asistent care face rezumate video în limba română." },
                                    { role: "user", content: `Fă un rezumat scurt pentru: ${transcriptText.substring(0, 4000)}` }
                                ]
                            });
                            translatedText = completion.choices[0].message.content;
                        }
                    } catch (e) { console.error("Eroare la descărcarea fișierului de subtitrare."); }
                }
            }
        }

        console.log(`✅ Procesare gata: ${title} | Download-uri: ${downloadLinks.length}`);

        res.json({
            success: true,
            title: title,
            downloads: downloadLinks.slice(0, 5), // Trimitem primele 5 cele mai relevante
            transcript: {
                original: transcriptText.substring(0, 2000),
                translated: translatedText
            }
        });

    } catch (error) {
        console.error("❌ Eroare Server:", error.message);
        res.status(500).json({ error: 'Eroare la procesarea API-ului.' });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server pornit pe portul ${PORT}`));