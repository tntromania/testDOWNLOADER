const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Argumente standard pentru yt-dlp
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        // Schimbăm user agent-ul pentru a părea un browser real
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        // TRUCUL MAGIC: Spunem yt-dlp să folosească clientul de Android
        '--extractor-args', 'youtube:player_client=android', 
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// SIMPLIFICAT: Extrage transcript direct cu --write-auto-sub
async function getTranscript(url) {
    return new Promise((resolve) => {
        const args = [
            ...getYtDlpArgs(),
            '--skip-download',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--sub-format', 'txt',
            '--output', '/tmp/transcript_%(id)s',
            '--print', 'id',
            url
        ];

        console.log('🔍 Execut yt-dlp pentru transcript...');
        const process = spawn(YTDLP_PATH, args);
        
        let videoId = '';
        process.stdout.on('data', (data) => {
            videoId = data.toString().trim();
            console.log('📹 Video ID:', videoId);
        });

        process.stderr.on('data', (data) => {
            console.log('ℹ️ yt-dlp:', data.toString());
        });

        process.on('close', () => {
            if (!videoId) {
                console.log('❌ Nu am primit Video ID');
                resolve(null);
                return;
            }

            const txtFile = `/tmp/transcript_${videoId}.en.txt`;
            
            console.log('🔍 Caut fișierul:', txtFile);
            
            if (fs.existsSync(txtFile)) {
                try {
                    const content = fs.readFileSync(txtFile, 'utf8');
                    console.log('✅ Transcript găsit! Dimensiune:', content.length, 'caractere');
                    
                    // Curățăm fișierul
                    fs.unlinkSync(txtFile);
                    
                    resolve(content.trim());
                } catch (e) {
                    console.error('❌ Eroare citire:', e);
                    resolve(null);
                }
            } else {
                console.log('❌ Fișierul nu există:', txtFile);
                resolve(null);
            }
        });
    });
}

// Metadata
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
        
        const transcript = await getTranscript(videoUrl);
        
        if (transcript) {
            console.log('✅ Transcript extras cu succes!');
        } else {
            console.log('⚠️ Nu există transcript disponibil');
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
                transcript: transcript || "Nu există transcript disponibil pentru acest video."
            }
        });

    } catch (error) {
        console.error('❌ Eroare:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

// ENDPOINT STREAMING
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
    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});