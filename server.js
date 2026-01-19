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

    try {
        const headers = { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST };

        // Facem cererile către API
        const [videoRes, subtitleRes] = await Promise.allSettled([
            axios.get(`https://${RAPIDAPI_HOST}/video.php`, { params: { id: videoId }, headers }),
            axios.get(`https://${RAPIDAPI_HOST}/subtitle.php`, { params: { id: videoId }, headers })
        ]);

        let title = "Video YouTube";
        let downloadLinks = [];
        let transcriptText = "Nu există subtitrări disponibile.";
        let translatedText = "Fără traducere.";

        // --- LOGICA REPARATĂ PENTRU DOWNLOAD ---
        if (videoRes.status === 'fulfilled') {
            const rawData = videoRes.value.data;
            // API-ul tău pune totul în obiectul .data
            const videoData = rawData.data || {};
            title = videoData.title || title;

            // Colectăm toate formatele posibile
            const formats = [
                ...(videoData.formats || []),
                ...(videoData.adaptive_formats || [])
            ];

            if (formats.length > 0) {
                // Căutăm un MP4 cu sunet (muxed) sau cel mai bun adaptive
                const bestVideo = formats.find(f => f.quality === '720p' && f.container === 'mp4') || 
                                  formats.find(f => f.container === 'mp4');
                
                if (bestVideo && bestVideo.url) {
                    downloadLinks.push({ type: 'video', url: bestVideo.url, label: bestVideo.quality || 'MP4' });
                }

                // Căutăm un Audio (m4a/mp3)
                const bestAudio = formats.find(f => f.type && f.type.includes('audio')) || 
                                  formats.find(f => f.extension === 'm4a');
                if (bestAudio && bestAudio.url) {
                    downloadLinks.push({ type: 'audio', url: bestAudio.url, label: 'MP3/AUDIO' });
                }
            }
        }

        // --- LOGICA REPARATĂ PENTRU TRANSCRIPT ---
        if (subtitleRes.status === 'fulfilled') {
            const subtitleData = subtitleRes.value.data.data || subtitleRes.value.data;
            if (Array.isArray(subtitleData) && subtitleData.length > 0) {
                const enSub = subtitleData.find(s => s.lang === 'en') || subtitleData[0];
                if (enSub && enSub.url) {
                    const subFile = await axios.get(enSub.url);
                    let rawContent = typeof subFile.data === 'string' ? subFile.data : JSON.stringify(subFile.data);
                    
                    // Curățare rapidă de tag-uri XML/VTT
                    transcriptText = rawContent.replace(/<[^>]*>/g, ' ').replace(/WEBVTT/g, '').replace(/\d+:\d+:\d+\.\d+/g, '').replace(/\s+/g, ' ').trim();

                    if (process.env.OPENAI_API_KEY && transcriptText.length > 10) {
                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [{ role: "system", content: "Ești un asistent care rezumă videoclipuri în limba română." }, { role: "user", content: transcriptText.substring(0, 4000) }]
                        });
                        translatedText = completion.choices[0].message.content;
                    }
                }
            }
        }

        res.json({
            success: true,
            title: title,
            downloads: downloadLinks,
            transcript: { original: transcriptText, translated: translatedText }
        });

    } catch (error) {
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server finalizat pornit pe ${PORT}`));