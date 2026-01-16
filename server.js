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

// Argumente standard pentru yt-dlp
function getYtDlpArgs() {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--force-ipv4',
        // User Agent de Android pentru a evita blocajele la download
        '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        '--extractor-args', 'youtube:player_client=android', 
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    return args;
}

// ✅ METODA ACTUALIZATĂ: Gestionează Shorts si User-Agent
async function getTranscript(url) {
    console.log('🔍 Extrag transcript via youtube-transcript...');
    
    // 1. Conversie URL din Shorts/Mobile în format standard watch?v=ID
    // Asta ajuta libraria sa nu se blocheze in redirect-uri
    let videoId = '';
    try {
        if (url.includes('shorts/')) {
            videoId = url.split('shorts/')[1].split('?')[0];
        } else if (url.includes('v=')) {
            videoId = url.split('v=')[1].split('&')[0];
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1].split('?')[0];
        }
    } catch (e) {
        console.log('⚠️ Nu am putut parsa ID-ul, folosesc URL original');
    }

    // Dacă am găsit ID-ul, construim un URL curat, altfel îl folosim pe cel primit
    const cleanUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    console.log(`ℹ️ URL folosit pentru transcript: ${cleanUrl}`);

    try {
        // 2. Apelăm librăria cu HEADERS DE BROWSER (Foarte important pe VPS!)
        const transcriptItems = await YoutubeTranscript.fetchTranscript(cleanUrl, {
            lang: 'en',
            fetchOptions: {
                headers: {
                    // Ne prefacem ca suntem un PC cu Chrome, nu un bot
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                }
            }
        });
        
        const fullText = transcriptItems.map(item => item.text).join(' ');
        
        const cleanText = fullText
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\[.*?\]/g, ""); 

        console.log('✅ Transcript extras! Lungime:', cleanText.length);
        return cleanText;

    } catch (e) {
        console.error('❌ Eroare transcript:', e.message);
        
        // Fallback: Uneori merge mai bine daca incercam explicit cu ID-ul, nu cu URL-ul
        if (videoId && e.message.includes('Impossible to retrieve')) {
             console.log('🔄 Încerc din nou folosind doar Video ID...');
             try {
                const retryItems = await YoutubeTranscript.fetchTranscript(videoId, {
                    lang: 'en',
                    fetchOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    }
                });
                const retryText = retryItems.map(item => item.text).join(' ');
                console.log('✅ Transcript extras la a doua încercare!');
                return retryText;
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
        
        if (!transcript) {
            console.log('⚠️ Transcript indisponibil.');
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
                transcript: transcript || "Nu există transcript disponibil (sau YouTube a blocat accesul)."
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

    const streamingArgs = getYtDlpArgs();
    const args = [
        ...streamingArgs,
        '-o', '-',
        '-f', isAudio ? 'bestaudio' : 'best',
        videoUrl
    ];

    const streamProcess = spawn(YTDLP_PATH, args);
    streamProcess.stdout.pipe(res);
    
    streamProcess.stderr.on('data', (data) => {
        if(data.toString().includes('ERROR')) console.error('Stream Error:', data.toString());
    });

    req.on('close', () => streamProcess.kill());
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server pornit pe portul ${PORT}`);
});