const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.static(__dirname));

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// 🍪 Funcție care transformă cookies.txt în String pentru Header
function getCookieHeader() {
    if (!fs.existsSync(COOKIES_PATH)) {
        console.log('⚠️ Nu am găsit cookies.txt! Transcriptul poate eșua pe VPS.');
        return '';
    }

    try {
        const content = fs.readFileSync(COOKIES_PATH, 'utf8');
        const lines = content.split('\n');
        let cookieString = '';

        for (const line of lines) {
            // Ignorăm comentariile și liniile goale
            if (line.startsWith('#') || !line.trim()) continue;
            
            const parts = line.split('\t');
            // Formatul Netscape are 7 coloane, cookie-ul e pe coloanele 5 (nume) și 6 (valoare)
            if (parts.length >= 7) {
                const name = parts[5];
                const value = parts[6];
                cookieString += `${name}=${value}; `;
            }
        }
        console.log('🍪 Cookies încărcate cu succes pentru Request!');
        return cookieString;
    } catch (e) {
        console.error('❌ Eroare parsare cookies:', e);
        return '';
    }
}

// Argumente standard pentru yt-dlp
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
    ];
    
    // Aici folosim fișierul direct pentru download (yt-dlp știe să îl citească)
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// ✅ METODA DE TRANSCRIPT (Cu Cookies injectate)
async function getTranscript(url) {
    console.log('🔍 Extrag transcript via youtube-transcript...');
    
    // 1. Curățare URL
    let videoId = '';
    try {
        if (url.includes('shorts/')) videoId = url.split('shorts/')[1].split('?')[0];
        else if (url.includes('v=')) videoId = url.split('v=')[1].split('&')[0];
        else if (url.includes('youtu.be/')) videoId = url.split('youtu.be/')[1].split('?')[0];
    } catch (e) {}

    const cleanUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    
    // 2. Pregătim Cookies
    const cookieHeader = getCookieHeader();

    try {
        // 3. Facem request-ul CU COOKIES
        // Asta îl face pe YouTube să creadă că ești logat
        const transcriptItems = await YoutubeTranscript.fetchTranscript(cleanUrl, {
            lang: 'en',
            fetchOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Cookie': cookieHeader // <--- Aici e secretul
                }
            }
        });
        
        const fullText = transcriptItems.map(item => item.text).join(' ');
        
        // Curățare text
        const cleanText = fullText
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\[.*?\]/g, "")
            .replace(/\(.*?\)/g, ""); // Scoate și parantezele rotunde

        console.log('✅ Transcript extras! Lungime:', cleanText.length);
        return cleanText;

    } catch (e) {
        console.error('❌ Eroare transcript:', e.message);
        
        // Retry logic doar pe ID dacă prima metodă eșuează
        if (videoId && (e.message.includes('Impossible') || e.message.includes('disabled'))) {
             console.log('🔄 Încerc din nou pe Video ID cu Cookies...');
             try {
                const retryItems = await YoutubeTranscript.fetchTranscript(videoId, {
                    lang: 'en',
                    fetchOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Cookie': cookieHeader
                        }
                    }
                });
                return retryItems.map(item => item.text).join(' ');
             } catch (err2) {
                 console.error('❌ A eșuat și a doua oară.');
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

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    console.log('\n🎬 Processing:', videoUrl);

    try {
        const metadata = await getYtMetadata(videoUrl);
        console.log('📝 Titlu:', metadata.title);
        
        const transcript = await getTranscript(videoUrl);
        
        if (!transcript) console.log('⚠️ Transcript indisponibil.');

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
                transcript: transcript || "Nu s-a putut extrage transcriptul (Cookie check required)."
            }
        });

    } catch (error) {
        console.error('❌ Eroare generală:', error);
        res.status(500).json({ error: 'Eroare la procesare.' });
    }
});

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
    
    streamProcess.stderr.on('data', (data) => {
        // Ignoram erorile minore
        if(data.toString().includes('ERROR')) console.error('Stream Error:', data.toString());
    });

    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});