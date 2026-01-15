const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURARE ---
// Cheia ta este hardcodată aici pentru siguranță, ca să nu depindă de ENV
const OPENAI_API_KEY = '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';
const YTDLP_PATH = 'yt-dlp';

// --- 1. CURĂȚARE TEXT (VTT) ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        // Eliminăm gunoaiele tehnice din VTT
        if (
            !line || 
            line.includes('-->') || 
            /^\d+$/.test(line) || 
            line.startsWith('WEBVTT') || 
            line.startsWith('Kind:') || 
            line.startsWith('Language:')
        ) return;

        // Eliminăm tag-urile HTML (<c.color...>)
        line = line.replace(/<[^>]*>/g, '');
        
        // Eliminăm duplicatele consecutive
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE GPT (SIMPLIFICATĂ PENTRU STABILITATE) ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Text insuficient.";
    
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural." },
                { "role": "user", "content": text.substring(0, 4000) } // Limităm lungimea
            ],
            temperature: 0.3
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        console.error("Eroare GPT:", e.message);
        return await translateWithGoogle(text); // Fallback
    }
}

// --- 3. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    try {
        const res = await translate(text.substring(0, 4000), { to: 'ro' });
        return res.text;
    } catch (e) { return text; }
}

// --- 4. EXTRAGERE TRANSCRIPT (METODA SIGURĂ) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    // Nu punem extensia în output template, yt-dlp o pune singur
    const outputTemplate = path.join(__dirname, `sub_${uniqueId}`);

    return new Promise((resolve) => {
        const args = [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en,ro', // Încearcă engleză sau română
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            '--no-warnings',
            url
        ];

        const process = spawn(YTDLP_PATH, args);

        process.on('close', (code) => {
            // Căutăm ORICE fișier care începe cu ID-ul nostru și se termină în .vtt
            const dirFiles = fs.readdirSync(__dirname);
            const foundFile = dirFiles.find(f => f.startsWith(`sub_${uniqueId}`) && f.endsWith('.vtt'));

            if (foundFile) {
                try {
                    const fullPath = path.join(__dirname, foundFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const clean = cleanVttText(content);
                    fs.unlinkSync(fullPath); // Curățenie
                    resolve(clean);
                } catch (e) {
                    console.error("Eroare citire VTT:", e);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

// --- 5. ENDPOINT DOWNLOAD ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`\n▶️ Procesez: ${videoUrl}`);

    try {
        // A. METADATE (Titlu, Durată)
        const metadata = await new Promise(resolve => {
            const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', videoUrl]);
            let d = '';
            proc.stdout.on('data', c => d += c);
            proc.on('close', () => {
                try { resolve(JSON.parse(d)); } 
                catch { resolve({ title: "Video Fără Titlu", duration_string: "N/A", description: "" }); }
            });
        });

        // B. TRANSCRIPT (Doar pt YouTube)
        let transcriptData = null;
        if (videoUrl.includes('youtu')) {
            let originalText = await getOriginalTranscript(videoUrl);
            
            // Dacă nu e subtitrare, luăm descrierea
            if (!originalText && metadata.description) {
                console.log("⚠️ Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description;
            }

            if (originalText) {
                const translatedText = await translateWithGPT(originalText);
                transcriptData = {
                    original: originalText,
                    translated: translatedText
                };
            }
        }

        // C. GENERARE FORMATE (CRITIC PENTRU HTML-UL TĂU)
        // HTML-ul tău caută exact string-urile: "360p", "1080p", etc.
        // Trebuie să construim array-ul exact așa cum vrea el.
        const qualities = ['360', '480', '720', '1080', '1440', '2160'];
        const formats = [];

        // Generăm opțiunile video
        qualities.forEach(q => {
            formats.push({
                quality: q + 'p', // Rezultă "1080p" -> HTML-ul va fi fericit
                format: 'mp4',
                hasVideo: true,
                hasAudio: true,
                url: `/api/stream?type=video&url=${encodeURIComponent(videoUrl)}`
            });
        });

        // Generăm opțiunea audio
        formats.push({
            quality: '192', // HTML-ul caută "192" la audio
            format: 'mp3',
            hasVideo: false,
            hasAudio: true,
            url: `/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}`
        });

        // D. TRIMITEM RĂSPUNSUL
        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats, // Lista corectă
                transcript: transcriptData
            }
        });

    } catch (error) {
        console.error("Eroare server:", error);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

// --- 6. ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    spawn(YTDLP_PATH, args).stdout.pipe(res);
});

// Servește HTML
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server gata pe portul ${PORT}`);
});