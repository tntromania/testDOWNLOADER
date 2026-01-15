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
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ==========================================
// MODIFICARE 1: Funcția Helper Anti-Block
// ==========================================
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        '--sleep-requests', '1',
        '--sleep-interval', '2',
        '--sleep-subtitles', '1'
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// --- VALIDARE PLATFORMĂ ---
function detectPlatform(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
    if (urlLower.includes('tiktok.com')) return 'tiktok';
    if (urlLower.includes('instagram.com')) return 'instagram';
    if (urlLower.includes('facebook.com') || urlLower.includes('fb.watch') || urlLower.includes('fb.com')) return 'facebook';
    return 'unknown';
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
            line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Tip:') || 
            line.startsWith('Limbă:') || line.startsWith('Style:')) {
            return;
        }
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE GPT-4o-mini CU LOGS ---
async function translateWithAI(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    
    console.log("\n--- [AI DEBUG] Începe procesul de traducere ---");
    console.log("Text de tradus (primele 200 caractere):", text.substring(0, 200));
    
    if (OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { "role": "system", "content": "Ești un traducător profesionist. Tradu textul în limba Română, natural și fluent." },
                    { "role": "user", "content": text.substring(0, 4000) }
                ],
                temperature: 0.3
            }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } });

            console.log("✅ Traducere GPT-4o-mini reușită");
            return response.data.choices[0].message.content;
        } catch (e) { 
            console.error("[AI ERROR] GPT eșuat:", e.message);
        }
    }
    console.log("ℹ️ Fallback la google-translate-api");
    try {
        const res = await translate(text.substring(0, 4500), { to: 'ro' });
        return res.text;
    } catch (err) { 
        console.error("[ERROR] Traducere google-translate eșuată:", err.message);
        return "Traducere indisponibilă."; 
    }
}

// ==========================================
// MODIFICARE CRITICĂ: getOriginalTranscript îmbunătățit
// ==========================================
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    console.log(`\n--- [TRANSCRIPT DEBUG] Se caută transcript pentru URL: ${url.substring(0, 50)}... ---`);

    // Încercăm mai multe strategii pentru a găsi transcriptul
    const strategies = [
        // Strategia 1: Prioritizează subtitrările auto-generate în limba engleză
        {
            name: "Auto-generated English",
            args: [
                ...getYtDlpArgs(),
                '--skip-download',
                '--write-auto-sub',
                '--sub-langs', 'en',
                '--convert-subs', 'vtt',
                '--output', outputTemplate,
                url
            ]
        },
        // Strategia 2: Încearcă orice subtitrare disponibilă
        {
            name: "Any available subtitles",
            args: [
                ...getYtDlpArgs(),
                '--skip-download',
                '--write-sub',
                '--sub-langs', 'all',
                '--convert-subs', 'vtt',
                '--output', outputTemplate,
                url
            ]
        },
        // Strategia 3: Fără specificare de limbă
        {
            name: "No language restriction",
            args: [
                ...getYtDlpArgs(),
                '--skip-download',
                '--write-auto-sub',
                '--convert-subs', 'vtt',
                '--output', outputTemplate,
                url
            ]
        }
    ];

    for (const strategy of strategies) {
        console.log(`🔄 Încercare: ${strategy.name}`);
        
        try {
            const text = await tryDownloadTranscript(strategy.args, uniqueId, outputTemplate);
            if (text && text.length > 10) {
                console.log(`✅ Succes cu strategia: ${strategy.name}`);
                console.log(`📄 Lungime transcript: ${text.length} caractere`);
                console.log(`📄 Primele 200 caractere: ${text.substring(0, 200)}`);
                return text;
            }
        } catch (error) {
            console.log(`❌ Eșec strategia ${strategy.name}:`, error.message);
            // Curățăm fișierele temporare
            cleanupTempFiles(uniqueId);
        }
    }

    console.log("⚠️ Nu s-a putut obține niciun transcript cu nicio strategie");
    return null;
}

// Funcție helper pentru a încerca descărcarea transcriptului
function tryDownloadTranscript(args, uniqueId, outputTemplate) {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args);
        let stderr = '';
        
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            console.log(`Exit code: ${code}`);
            
            // Așteptăm puțin ca fișierul să fie scris complet
            setTimeout(() => {
                try {
                    const files = fs.readdirSync(__dirname);
                    const vttFiles = files.filter(f => f.startsWith(`trans_${uniqueId}`) && f.endsWith('.vtt'));
                    
                    console.log(`Fișiere VTT găsite: ${vttFiles.length}`);
                    if (vttFiles.length > 0) {
                        console.log(`Fișiere: ${vttFiles.join(', ')}`);
                    }

                    if (vttFiles.length > 0) {
                        const filePath = path.join(__dirname, vttFiles[0]);
                        const content = fs.readFileSync(filePath, 'utf8');
                        const text = cleanVttText(content);
                        
                        // Curățăm fișierele temporare
                        cleanupTempFiles(uniqueId);
                        
                        if (text.length > 10) {
                            resolve(text);
                        } else {
                            console.log("⚠️ Fișier VTT gol sau conținut insuficient");
                            reject(new Error("Fișier VTT gol"));
                        }
                    } else {
                        console.log("❌ Nu s-au găsit fișiere VTT");
                        console.log("Stderr:", stderr.substring(0, 500));
                        reject(new Error("Nu s-au găsit fișiere VTT"));
                    }
                } catch (e) {
                    console.log("❌ Eroare la procesarea fișierelor:", e.message);
                    reject(e);
                }
            }, 500);
        });

        proc.on('error', (error) => {
            console.error("❌ Eroare la spawn:", error.message);
            reject(error);
        });
    });
}

// Funcție pentru curățarea fișierelor temporare
function cleanupTempFiles(uniqueId) {
    try {
        const files = fs.readdirSync(__dirname);
        const tempFiles = files.filter(f => f.startsWith(`trans_${uniqueId}`));
        tempFiles.forEach(f => {
            try {
                fs.unlinkSync(path.join(__dirname, f));
            } catch (e) {
                // Ignorăm erorile la ștergere
            }
        });
    } catch (e) {
        // Ignorăm erorile la citire
    }
}

// ==========================================
// MODIFICARE 3: getYtMetadata cu args noi
// ==========================================
async function getYtMetadata(url) {
    try {
        const oembed = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
        return { title: oembed.data.title };
    } catch (e) {
        return new Promise((resolve) => {
            const args = [...getYtDlpArgs(), '--dump-json', '--no-warnings', url];
            const proc = spawn(YTDLP_PATH, args);
            let buf = '';
            proc.stdout.on('data', d => buf += d);
            proc.on('close', () => {
                try { 
                    const data = JSON.parse(buf);
                    resolve({ title: data.title || "Video" }); 
                } catch (e) { resolve({ title: "Video" }); }
            });
        });
    }
}

// --- ENDPOINT PRINCIPAL ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    const requestedPlatform = req.query.platform || 'youtube';
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`\n========================================`);
    console.log(`🎬 NOU REQUEST: ${videoUrl.substring(0, 50)}...`);
    console.log(`Platform: ${requestedPlatform}`);
    console.log(`========================================\n`);

    const detectedPlatform = detectPlatform(videoUrl);
    if (detectedPlatform !== requestedPlatform) {
        return res.status(400).json({ error: `URL incorect! Ai selectat ${requestedPlatform.toUpperCase()} dar link-ul este de la ${detectedPlatform.toUpperCase()}.` });
    }

    try {
        const metadata = await getYtMetadata(videoUrl);
        console.log(`✅ Metadata obținut: ${metadata.title}`);
        
        let transcriptData = null;

        if (detectedPlatform === 'youtube') {
            console.log(`🔄 Începem extragerea transcriptului...`);
            const originalText = await getOriginalTranscript(videoUrl);
            
            if (originalText && originalText.length > 10) {
                console.log(`🔄 Începem traducerea...`);
                const translatedText = await translateWithAI(originalText);
                
                transcriptData = {
                    original: originalText.substring(0, 3000),
                    translated: translatedText
                };
                
                console.log(`✅ Transcript complet cu succes!`);
            } else {
                console.log(`⚠️ Nu s-a putut obține transcriptul`);
                transcriptData = {
                    original: null,
                    translated: null
                };
            }
        }

        const formats = ['360', '480', '720', '1080'].map(q => ({
            quality: q + 'p', format: 'mp4',
            url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=video`
        }));
        formats.push({ quality: '192', format: 'mp3', url: `/api/stream?url=${encodeURIComponent(videoUrl)}&type=audio` });

        const responseData = {
            status: 'ok',
            data: {
                title: metadata.title,
                platform: detectedPlatform,
                formats: formats,
                transcript: transcriptData
            }
        };
        
        console.log(`📦 Răspuns final trimis către client`);
        console.log(`Transcript included: ${!!transcriptData && !!transcriptData.original}`);
        
        res.json(responseData);
    } catch (e) { 
        console.error(`❌ EROARE CRITICĂ:`, e.message);
        res.status(500).json({ error: 'Eroare procesare.' }); 
    }
});

// ==========================================
// MODIFICARE 4: Streaming cu args noi
// ==========================================
app.get('/api/stream', (req, res) => {
    const isAudio = req.query.type === 'audio';
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    
    const baseArgs = getYtDlpArgs().filter(arg => !arg.includes('sleep'));
    const args = [
        ...baseArgs,
        '-o', '-', 
        '-f', isAudio ? 'bestaudio' : 'best', 
        req.query.url
    ];

    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server pornit pe ${PORT}`));