const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Funcție de curățare a subtitrărilor VTT (formatul YouTube)
function cleanVttText(vttContent) {
    const lines = vttContent.split('\n');
    const uniqueLines = new Set();
    
    lines.forEach(line => {
        line = line.trim();
        // Eliminăm header-ul, timestamp-urile și liniile goale
        if (!line || 
            line.startsWith('WEBVTT') || 
            line.startsWith('Kind:') || 
            line.startsWith('Language:') || 
            line.includes('-->') || 
            /^\d+$/.test(line)) { // Elimină numerele de index
            return;
        }
        // Eliminăm tag-urile de stil <c>...</c> și alte tag-uri HTML
        const cleanLine = line.replace(/<[^>]*>/g, '').trim();
        if (cleanLine) uniqueLines.add(cleanLine);
    });

    return Array.from(uniqueLines).join(' ');
}

// ✅ Extragere Transcript folosind YT-DLP (Mult mai robust)
async function getTranscriptWithYtDlp(url) {
    return new Promise((resolve, reject) => {
        const outputBase = `/tmp/transcript_${Date.now()}`;
        
        // Comanda: descarcă DOAR subtitrarea, nu video-ul
        // --write-subs: subtitrări manuale
        // --write-auto-subs: subtitrări automate (AICI E CHEIA)
        // --sub-lang "en,ro,.*": încearcă engleză, română, sau orice altceva
        const args = [
            '--no-warnings',
            '--no-check-certificates',
            '--force-ipv4',
            '--skip-download',      // Nu vrem video
            '--write-subs',         // Vrem subs manuale
            '--write-auto-subs',    // Vrem subs automate
            '--sub-lang', 'en,ro,.*', // Acceptăm orice limbă, preferabil en/ro
            '--sub-format', 'vtt',  // Format text standard
            '--output', outputBase, // Unde salvăm
            url
        ];

        // 🍪 Dacă avem cookies, le folosim! Asta rezolvă "Sign in"
        if (fs.existsSync(COOKIES_PATH)) {
            args.push('--cookies', COOKIES_PATH);
            args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }

        console.log('running yt-dlp for transcript...');
        const process = spawn(YTDLP_PATH, args);

        process.on('close', (code) => {
            // Căutăm fișierul generat (poate fi .en.vtt, .ro.vtt, .vtt etc.)
            const dir = '/tmp';
            try {
                const files = fs.readdirSync(dir);
                // Căutăm fișierul care începe cu ID-ul nostru temporar
                const transcriptFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));

                if (transcriptFile) {
                    const fullPath = path.join(dir, transcriptFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    
                    // Curățăm fișierul temporar
                    fs.unlinkSync(fullPath);
                    
                    // Procesăm textul
                    const cleanText = cleanVttText(content);
                    console.log(`✅ Transcript extras via yt-dlp! Lungime: ${cleanText.length}`);
                    resolve(cleanText);
                } else {
                    console.error('❌ yt-dlp nu a salvat niciun fișier .vtt');
                    resolve(null);
                }
            } catch (err) {
                console.error('❌ Eroare citire fișier transcript:', err);
                resolve(null);
            }
        });
    });
}

// 🧠 Funcție Procesare GPT
async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return text + "\n(Lipsă API Key)";
    if (!text || text.length < 10) return text;

    console.log('🤖 Trimit textul la GPT...');
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Ești un editor. Formatează textul, corectează-l și tradu-l în Română. Fără alte comentarii." },
                { role: "user", content: text }
            ],
            max_tokens: 1500,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        console.error('❌ Eroare OpenAI:', e.message);
        return text;
    }
}

async function getYtMetadata(url) {
    try {
        // Folosim tot yt-dlp pentru metadata ca e mai sigur
        return new Promise(resolve => {
            const p = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
            let data = '';
            p.stdout.on('data', d => data += d);
            p.on('close', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ title: json.title, duration: json.duration_string });
                } catch { resolve({ title: "Video YouTube", duration: "--:--" }); }
            });
        });
    } catch (e) {
        return { title: "YouTube Video", duration: "--:--" };
    }
}

// ENDPOINT PRINCIPAL
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('\n🎬 Processing:', videoUrl);

    try {
        const metadata = await getYtMetadata(videoUrl);
        console.log('📝 Titlu:', metadata.title);
        
        // 1. Încercăm extragerea cu yt-dlp + cookies
        let transcript = await getTranscriptWithYtDlp(videoUrl);
        let processedTranscript = "";

        if (transcript) {
            // 2. GPT Processing
            processedTranscript = await processWithGPT(transcript);
        } else {
            processedTranscript = "Nu am putut extrage transcriptul. Asigură-te că video-ul are CC (chiar și auto-generated).";
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
                duration: metadata.duration,
                formats: formats,
                transcript: processedTranscript
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
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--referer', 'https://www.youtube.com/',
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});