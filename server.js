const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Setăm calea simplă pentru Linux. 
// ATENȚIE: Pe Coolify trebuie să te asiguri că yt-dlp este instalat în container!
const YTDLP_PATH = 'yt-dlp'; 

// --- FUNCȚIE DE LOGARE (Ca să vezi tot în consolă) ---
function logStep(step, message, data = '') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${step}] ${message}`, data ? data : '');
}

// --- 1. CURĂȚARE TEXT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('WEBVTT') || line.includes('-->') || /^\d+$/.test(line) || 
            line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Style:')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);
    
    logStep('TRANSCRIPT', 'Încep extragerea subtitrării...');

    return new Promise((resolve) => {
        const args = [
            '--skip-download', '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en', '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates', '--no-warnings',
            url
        ];

        const process = spawn(YTDLP_PATH, args);

        process.on('error', (err) => {
            logStep('EROARE CRITICĂ', 'Nu pot rula yt-dlp pentru transcript! E instalat?', err.message);
            resolve(null);
        });

        process.on('close', (code) => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                try {
                    const content = fs.readFileSync(foundFile, 'utf8');
                    fs.unlinkSync(foundFile);
                    logStep('TRANSCRIPT', '✅ Subtitrare găsită și curățată.');
                    resolve(cleanVttText(content));
                } catch (e) { 
                    logStep('TRANSCRIPT', '❌ Eroare la citirea fișierului.', e.message);
                    resolve(null); 
                }
            } else {
                logStep('TRANSCRIPT', '⚠️ Nicio subtitrare găsită.');
                resolve(null);
            }
        });
    });
}

// --- 3. TRADUCERE ---
async function translateSecure(text) {
    if (!text || text.length < 5) return "Nu există text suficient.";
    try {
        logStep('TRADUCERE', 'Trimit textul la Google Translate...');
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) {
        logStep('TRADUCERE', '❌ Eroare traducere:', err.message);
        return "Traducere momentan indisponibilă.";
    }
}

// --- 4. METADATA (Aici crapă de obicei) ---
function getYtMetadata(url) {
    return new Promise((resolve) => {
        logStep('METADATA', 'Extrag info video (Titlu/Durată)...');
        
        // Adaug user-agent ca să păcălim YouTube puțin
        const args = [
            '--dump-json', 
            '--no-warnings', 
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            url
        ];

        const process = spawn(YTDLP_PATH, args);
        let buffer = '';
        let errorBuffer = '';

        process.stdout.on('data', d => buffer += d);
        process.stderr.on('data', d => errorBuffer += d); // Prindem erorile de la yt-dlp

        process.on('error', (err) => {
            logStep('EROARE SERVER', '❌ COMANDA YT-DLP NU POATE FI RULATĂ!', err.message);
            logStep('SFAT', 'Pe Coolify, asigură-te că ai instalat python3 și yt-dlp în Dockerfile!');
            resolve({ title: "Eroare Server: yt-dlp lipsă", duration_string: "0:00" });
        });

        process.on('close', (code) => {
            if (code !== 0) {
                logStep('METADATA', '⚠️ yt-dlp a returnat cod de eroare:', code);
                logStep('METADATA STDERR', errorBuffer.toString()); // Vedem ce zice YouTube
            }

            try {
                if (!buffer) throw new Error("Buffer gol");
                const data = JSON.parse(buffer);
                logStep('METADATA', `✅ Succes! Titlu: ${data.title}`);
                resolve(data);
            } catch (e) {
                logStep('METADATA', '❌ Eșec parsare JSON. Probabil IP blocat sau yt-dlp vechi.');
                resolve({ title: "Titlu Indisponibil (Verifică Loguri)", description: "", duration_string: "N/A" });
            }
        });
    });
}

// --- ENDPOINTS ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    console.log('\n==================================================');
    logStep('START', `Procesare link nou: ${videoUrl}`);

    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    try {
        // 1. Metadata
        const metadata = await getYtMetadata(videoUrl);
        
        // 2. Transcript
        let originalText = await getOriginalTranscript(videoUrl);
        if (!originalText) {
            logStep('FALLBACK', 'Folosesc descrierea video ca text.');
            originalText = metadata.description || "Nu s-a găsit text.";
            originalText = originalText.replace(/https?:\/\/\S+/g, '');
        }

        // 3. Traducere
        let translatedText = "Se procesează...";
        if (originalText && originalText.length > 5 && originalText !== "Nu s-a găsit text.") {
            translatedText = await translateSecure(originalText);
        }

        // 4. Formate pentru Frontend-ul tău
        const formats = [
            { quality: 'MP4', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`, hasAudio: true, hasVideo: true },
            { quality: 'MP3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio`, hasAudio: true, hasVideo: false }
        ];

        logStep('FINAL', 'Trimit datele către client (Frontend).');
        console.log('==================================================\n');

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string,
                formats: formats,
                transcript: { original: originalText, translated: translatedText }
            }
        });

    } catch (error) {
        logStep('EXCEPTION', error.message);
        res.status(500).json({ error: 'Eroare internă.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    logStep('STREAM', `Start download: ${type} -> ${url}`);
    
    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');

    const args = ['-o', '-', '--no-warnings', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const process = spawn(YTDLP_PATH, args);
    
    process.stderr.on('data', d => {
        // Logăm erorile de stream doar dacă sunt critice
        if (d.toString().includes('error')) logStep('STREAM ERROR', d.toString());
    });
    
    process.stdout.pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server PRO ACTIV pe portul ${PORT}`);
    console.log(`📝 Aștept link-uri... verifică logs dacă nu merge!`);
});