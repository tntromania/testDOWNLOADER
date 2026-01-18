const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
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

// ⚡ CACHE MEMORIE
const memoryCache = new Map();

// Golire cache la 24h
setInterval(() => {
    console.log('🧹 Golire cache automat...');
    memoryCache.clear();
}, 24 * 60 * 60 * 1000);

// Endpoint Update Admin
app.get('/api/admin/update-ytdlp', (req, res) => {
    exec(`${YTDLP_PATH} -U`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Update error: ${error}`);
            return res.status(500).json({ error: stderr });
        }
        console.log(`Update yt-dlp: ${stdout}`);
        res.json({ message: 'Update success', log: stdout });
    });
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

function isYoutubeUrl(url) {
    return /(youtube\.com|youtu\.be)/i.test(url);
}

// 🔥 CONFIGURARE ANTI-BAN & IOS/ANDROID
function getFastArgs() {
    const args = [
        '--no-warnings', 
        '--no-check-certificates', 
        '--referer', 'https://www.youtube.com/',
        '--compat-options', 'no-youtube-unavailable-videos',
        '--no-playlist',
        
        // Păstrăm Android, e cel mai stabil acum
        '--extractor-args', 'youtube:player_client=android',
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    
    return args;
}

function cleanVttText(vttContent) {
    const lines = vttContent.split('\n');
    const uniqueLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line)) return;
        const cleanLine = line.replace(/<[^>]*>/g, '').trim();
        if (cleanLine) uniqueLines.add(cleanLine);
    });
    return Array.from(uniqueLines).join(' ');
}

async function getTranscriptWithYtDlp(url) {
    return new Promise((resolve) => {
        const outputBase = `/tmp/transcript_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const args = [
            ...getFastArgs(),
            '--skip-download', 
            '--write-subs', 
            '--write-auto-subs',
            '--sub-lang', 'en,ro,.*', 
            '--sub-format', 'vtt',
            '--output', outputBase,
            url
        ];

        const process = spawn(YTDLP_PATH, args);
        
        process.on('close', () => {
            const dir = '/tmp';
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const files = fs.readdirSync(dir);
                const transcriptFile = files.find(f => f.startsWith(path.basename(outputBase)) && f.endsWith('.vtt'));
                
                if (transcriptFile) {
                    const fullPath = path.join(dir, transcriptFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    fs.unlinkSync(fullPath); 
                    resolve(cleanVttText(content));
                } else {
                    resolve(null);
                }
            } catch (err) { resolve(null); }
        });
    });
}

// Metadata
async function getYtMetadata(url) {
    return new Promise(resolve => {
        const args = [
            ...getFastArgs(),
            '--print', '%(title)s|%(duration_string)s', 
            url
        ];
        
        const p = spawn(YTDLP_PATH, args);
        let data = '';
        let errorData = '';

        p.stdout.on('data', d => data += d);
        p.stderr.on('data', d => errorData += d);
        
        p.on('close', (code) => {
            const parts = data.trim().split('|');
            if (parts.length >= 2) {
                resolve({ title: parts[0], duration: parts[1] });
            } else {
                console.error(`❌ Metadata Error: ${errorData}`);
                resolve({ title: "Video Download (Procesare...)", duration: "--:--" });
            }
        });
    });
}

async function processWithGPT(text) {
    if (!process.env.OPENAI_API_KEY) return "Traducere indisponibilă (No API Key).";
    if (!text || text.length < 5) return "Text prea scurt.";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Traducere directă în română. Fără explicații." },
                { role: "user", content: text }
            ],
            max_tokens: 1000,
        });
        return completion.choices[0].message.content;
    } catch (e) {
        return "Eroare traducere GPT.";
    }
}

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    if (memoryCache.has(videoUrl)) {
        return res.json(memoryCache.get(videoUrl));
    }

    console.log('\n🎬 Processing:', videoUrl);
    const startTime = Date.now();
    const isYt = isYoutubeUrl(videoUrl);

    try {
        let metadataPromise = getYtMetadata(videoUrl);
        let transcriptPromise = isYt ? getTranscriptWithYtDlp(videoUrl) : Promise.resolve(null);

        const [metadata, rawTranscript] = await Promise.all([metadataPromise, transcriptPromise]);
        
        let transcriptObject = null;
        if (rawTranscript) {
            const translatedText = await processWithGPT(rawTranscript);
            transcriptObject = { original: rawTranscript, translated: translatedText };
        }

        const qualities = ['360', '480', '720', '1080'];
        const formats = qualities.map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        const responseData = {
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration,
                formats: formats,
                transcript: transcriptObject
            }
        };

        memoryCache.set(videoUrl, responseData);
        console.log(`✅ Gata în ${(Date.now() - startTime) / 1000}s`);
        res.json(responseData);

    } catch (error) {
        console.error('❌ Eroare server:', error);
        res.status(500).json({ error: 'Eroare server.' });
    }
});

// 🚀 ENDPOINT DOWNLOAD (RECRIS PENTRU STABILITATE)
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';
    
    // Generăm un nume de fișier temporar unic
    const tempFilename = `download_${Date.now()}_${Math.random().toString(36).substr(7)}.${isAudio ? 'mp3' : 'mp4'}`;
    const tempPath = path.join('/tmp', tempFilename);

    console.log(`⬇️ Start download în fișier temporar: ${tempPath}`);

    // Construim argumentele pentru download PE DISC (nu stdout)
    const args = [
        ...getFastArgs(),
        '-o', tempPath, // Salvăm în fișier
    ];

    if (isAudio) {
        args.push('-f', 'bestaudio/best');
        args.push('-x', '--audio-format', 'mp3'); // Conversie la MP3
    } else {
        // Aici e magia: lăsăm yt-dlp să descarce video+audio separat și să le lipească
        args.push('-f', 'bestvideo+bestaudio/best'); 
        args.push('--merge-output-format', 'mp4'); // Forțăm container MP4 final
    }

    args.push(videoUrl);

    // Pornim procesul de download
    const dlProcess = spawn(YTDLP_PATH, args);

    // Logăm erorile (dar nu oprim execuția pentru warning-uri)
    dlProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        // Filtrăm zgomotul, afișăm doar erorile
        if (msg.includes('ERROR')) console.error(`[YT-DLP Error]: ${msg}`);
    });

    dlProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempPath)) {
            console.log(`✅ Download complet. Se trimite fișierul...`);
            
            // Trimitem fișierul către client
            res.download(tempPath, tempFilename, (err) => {
                if (err) {
                    console.error('Eroare la trimiterea fișierului:', err);
                }
                // 🔥 CRITIC: Ștergem fișierul după ce s-a terminat (sau a dat eroare)
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    console.log(`🧹 Fișier temporar șters: ${tempPath}`);
                } catch (e) { console.error('Nu s-a putut șterge temp file:', e); }
            });
        } else {
            console.error(`❌ Download eșuat cu codul ${code}`);
            res.status(500).send('Download Failed');
            // Cleanup în caz de eroare
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server TURBO pornit pe portul ${PORT}`);
});