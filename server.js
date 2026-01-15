const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Servește fișiere statice (index.html, style.css etc.)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp'; // Verifică dacă calea e corectă pe serverul tău
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- 1. CURĂȚARE TEXT SIMPLĂ ---
// Elimină timpii și etichetele HTML din VTT pentru a avea text curat
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    return vttContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => {
            // Elimină liniile tehnice VTT
            return line && 
                   !line.startsWith('WEBVTT') && 
                   !line.includes('-->') && 
                   !/^\d+$/.test(line) && // elimină numerele de secvență
                   !line.startsWith('Kind:') && 
                   !line.startsWith('Language:');
        })
        .map(line => line.replace(/<[^>]*>/g, '')) // Elimină tag-uri <c> etc
        .filter((item, pos, self) => self.indexOf(item) == pos) // Elimină duplicatele consecutive
        .join(' ');
}

// --- 2. FUNCȚIA DE TRANSCRIPT (SUPER SIMPLIFICATĂ) ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputPrefix = path.join(__dirname, `sub_${uniqueId}`);

    // Argumente minime necesare pentru yt-dlp
    const args = [
        '--skip-download',      // Nu descărca video-ul
        '--write-auto-sub',     // Scrie subtitrare generată automat
        '--write-sub',          // Scrie subtitrare manuală (dacă există)
        '--convert-subs', 'vtt', // Convertește în format text simplu
        '--output', outputPrefix, // Nume fișier temporar
        '--no-check-certificates',
        url
    ];

    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, args);

        proc.on('close', (code) => {
            // Căutăm orice fișier creat care începe cu ID-ul nostru
            // yt-dlp poate numi fișierul .en.vtt, .ro.vtt, etc.
            fs.readdir(__dirname, (err, files) => {
                if (err) return resolve(null);

                const foundFile = files.find(f => f.startsWith(`sub_${uniqueId}`) && f.endsWith('.vtt'));

                if (foundFile) {
                    const fullPath = path.join(__dirname, foundFile);
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const cleaned = cleanVttText(content);
                        fs.unlinkSync(fullPath); // Ștergem fișierul temp
                        resolve(cleaned);
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    console.log("Nu s-a creat niciun fișier de subtitrare.");
                    resolve(null);
                }
            });
        });
    });
}

// --- 3. TRADUCERE AI ---
async function translateWithAI(text) {
    if (!text || text.length < 5) return "Nu există suficient text pentru traducere.";
    
    // Încercăm întâi cu OpenAI dacă există cheie
    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător. Tradu textul următor în limba Română, păstrând sensul. Nu adăuga comentarii." },
                    { "role": "user", "content": text.substring(0, 3000) } // Limităm lungimea pentru viteză/cost
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });
            return response.data.choices[0].message.content;
        } catch (e) { 
            console.error("Eroare OpenAI:", e.message); 
        }
    }
    
    // Fallback simplu dacă nu e cheie sau dă eroare
    return "Traducerea necesită un API Key valid sau textul este prea lung.";
}

// --- 4. METADATA (Titlu) ---
async function getYtMetadata(url) {
    return new Promise((resolve) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', url]);
        let buf = '';
        proc.stdout.on('data', d => buf += d);
        proc.on('close', () => {
            try { 
                const data = JSON.parse(buf);
                resolve({ title: data.title || "Video YouTube" }); 
            } catch (e) { 
                resolve({ title: "YouTube Video" }); 
            }
        });
    });
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`Procesare: ${videoUrl}`);

    try {
        // 1. Luăm titlul
        const metadata = await getYtMetadata(videoUrl);
        
        // 2. Luăm transcriptul (AICI AM SIMPLIFICAT)
        const originalText = await getOriginalTranscript(videoUrl);
        
        // 3. Traducem
        const translatedText = await translateWithAI(originalText);

        // 4. Formate download
        const formats = ['360', '720', '1080'].map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: 'Audio', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                formats: formats,
                transcript: {
                    original: originalText || "Nu s-a găsit text (video-ul nu are subtitrări).",
                    translated: translatedText
                }
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Eroare internă server.' });
    }
});

// --- ENDPOINT STREAMING ---
app.get('/api/stream', (req, res) => {
    const isAudio = req.query.type === 'audio';
    const url = req.query.url;
    
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    
    const args = ['-o', '-', '--no-warnings', '--force-ipv4', '-f', isAudio ? 'bestaudio' : 'best', url];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
    
    // Dacă clientul închide conexiunea, oprim procesul
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server simplificat pornit pe ${PORT}`));