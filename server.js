const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { YoutubeTranscript } = require('youtube-transcript');
const OpenAI = require('openai'); // 👈 Importăm OpenAI

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Inițializare OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Citește cheia din Coolify
});

// 🍪 Funcție avansată de parsare Cookies
function getCookieHeader() {
    if (!fs.existsSync(COOKIES_PATH)) {
        console.log('⚠️ Warning: cookies.txt lipsește!');
        return '';
    }
    try {
        const content = fs.readFileSync(COOKIES_PATH, 'utf8');
        const lines = content.split('\n');
        let cookieMap = new Map();

        for (const line of lines) {
            if (line.startsWith('#') || !line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length >= 7) {
                // Suprascriem duplicatele pentru a păstra ultimele valori
                cookieMap.set(parts[5], parts[6]);
            }
        }
        
        let cookieString = '';
        cookieMap.forEach((value, key) => {
            cookieString += `${key}=${value}; `;
        });
        
        console.log(`🍪 Cookies parsate: ${cookieMap.size} valori găsite.`);
        return cookieString;
    } catch (e) {
        console.error('❌ Eroare parsare cookies:', e);
        return '';
    }
}

// Configurare yt-dlp
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
    ];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// 🧠 Funcție Procesare GPT-4o-mini
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) {
        return text + "\n\n(Nota: Traducerea AI nu a rulat. Adaugă OPENAI_API_KEY în Coolify.)";
    }
    if (!text || text.length < 10) return text;

    console.log('🤖 Trimit textul la GPT-4o-mini...');
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "Ești un editor expert. Primești un transcript brut de YouTube. Sarcina ta este să îl corectezi gramatical, să îl formatezi frumos și să îl traduci în limba Română (dacă nu e deja). Păstrează tonul original. Nu adăuga comentarii extra, doar textul curat." 
                },
                { 
                    role: "user", 
                    content: text 
                }
            ],
            max_tokens: 1000,
        });
        console.log('✨ GPT a răspuns!');
        return completion.choices[0].message.content;
    } catch (e) {
        console.error('❌ Eroare OpenAI:', e.message);
        return text; // Returnăm textul original dacă AI-ul eșuează
    }
}

// ✅ Extragere Transcript
async function getTranscript(url) {
    console.log('🔍 Încep extragerea transcriptului...');
    
    // 1. Curățare URL
    let videoId = '';
    try {
        if (url.includes('shorts/')) videoId = url.split('shorts/')[1].split('?')[0];
        else if (url.includes('v=')) videoId = url.split('v=')[1].split('&')[0];
        else if (url.includes('youtu.be/')) videoId = url.split('youtu.be/')[1].split('?')[0];
    } catch (e) {}

    const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    const cookieHeader = getCookieHeader();

    // Headers identice cu un browser real
    const fetchOpts = {
        lang: 'en', // Încearcă engleză prima dată
        fetchOptions: {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': cookieHeader
            }
        }
    };

    try {
        // Încercare 1: Direct cu URL
        const items = await YoutubeTranscript.fetchTranscript(targetUrl, fetchOpts);
        return items.map(i => i.text).join(' ');
    } catch (e) {
        console.error('❌ Eroare transcript prima încercare:', e.message);
        
        // Încercare 2: Doar cu Video ID (uneori merge mai bine)
        if (videoId) {
            console.log('🔄 Retry cu Video ID...');
            try {
                const items = await YoutubeTranscript.fetchTranscript(videoId, fetchOpts);
                return items.map(i => i.text).join(' ');
            } catch (err2) {
                console.error('❌ A eșuat și retry-ul.');
                return null;
            }
        }
        return null;
    }
}

async function getYtMetadata(url) {
    try {
        const oembed = await fetch(`https://www.youtube.com/oembed?url=${url}&format=json`);
        const data = await oembed.json();
        return { title: data.title, duration_string: "--:--" };
    } catch (e) {
        return { title: "YouTube Video", duration_string: "--:--" };
    }
}

// ENDPOINT PRINCIPAL
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('\n🎬 Processing:', videoUrl);

    try {
        const metadata = await getYtMetadata(videoUrl);
        
        // 1. Luăm transcriptul brut
        let transcript = await getTranscript(videoUrl);
        let processedTranscript = "";

        if (transcript) {
            // 2. Curățăm textul brut
            transcript = transcript
                .replace(/&amp;/g, '&')
                .replace(/&#39;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/\[.*?\]/g, "");
            
            console.log(`📜 Transcript brut lungime: ${transcript.length}`);

            // 3. Trimitem la GPT pentru traducere/formatare
            processedTranscript = await processWithGPT(transcript);
        } else {
            console.log('⚠️ Nu există transcript.');
            processedTranscript = "Nu am putut extrage transcriptul pentru acest video.";
        }

        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', 
            format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));

        formats.push({
            quality: '192', 
            format: 'mp3',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`
        });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: processedTranscript // Aici vine textul de la GPT
            }
        });

    } catch (error) {
        console.error('❌ Eroare server:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// ENDPOINT STREAMING
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';

    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const args = [
        ...getYtDlpArgs(),
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});