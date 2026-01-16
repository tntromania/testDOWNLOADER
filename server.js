const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
// 👇 AICI ESTE NOUTATEA
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Argumente standard pentru yt-dlp (FOLOSITE DOAR LA DOWNLOAD ACUM)
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        // Truc extra pentru download ca sa nu fii blocat
        '--extractor-args', 'youtube:player_client=android', 
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// ✅ METODA NOUĂ: Extrage transcript folosind librăria (fără yt-dlp)
async function getTranscript(url) {
    console.log('🔍 Extrag transcript via youtube-transcript...');
    try {
        // Aceasta functie face request direct la API-ul de subtitrari
        const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
        
        // Unim bucatile de text
        const fullText = transcriptItems.map(item => item.text).join(' ');
        
        // Curatam textul de caractere ciudate
        const cleanText = fullText
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\[.*?\]/g, ""); // Scoate chestii gen [Music]

        console.log('✅ Transcript extras! Lungime:', cleanText.length);
        return cleanText;
    } catch (e) {
        console.error('❌ Eroare transcript:', e.message);
        // Putem returna un mesaj user-ului sau null
        return null; 
    }
}

// Metadata (Titlu etc.)
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
        console.log('📝 Titlu:', metadata.title);
        
        // Aici apelam noua functie de transcript
        const transcript = await getTranscript(videoUrl);
        
        if (!transcript) {
            console.log('⚠️ Nu am putut extrage transcriptul.');
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
                // Trimitem mesaj daca e null
                transcript: transcript || "Transcript indisponibil (Video-ul nu are subtitrări sau este blocat)."
            }
        });

    } catch (error) {
        console.error('❌ Eroare generală:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// ENDPOINT STREAMING (Asta a ramas pe yt-dlp)
app.get('/api/stream', (req, res) => {
    const videoUrl = req.query.url;
    const isAudio = req.query.type === 'audio';

    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'audio.mp3' : 'video.mp4'}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    const streamingArgs = getYtDlpArgs();
    const args = [
        ...streamingArgs,
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    
    // Loguri pentru erori la stream
    streamProcess.stderr.on('data', (data) => {
        // Ignoram warning-urile, afisam doar erorile grave
        if(data.toString().includes('ERROR')) console.error('Stream Error:', data.toString());
    });

    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});