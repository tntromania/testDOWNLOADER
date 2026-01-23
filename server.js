import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Download video și obține transcript
app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'YouTube URL este obligatoriu' });
    }

    // Extrage video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'URL YouTube invalid' });
    }

    console.log(`Processing video: ${videoId}`);

    // Apelează RapidAPI pentru download info
    const downloadResponse = await axios.get(
      'https://youtube-video-and-shorts-downloader.p.rapidapi.com/download',
      {
        params: {
          url: url,
        },
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
        },
      }
    );

    const downloadData = downloadResponse.data;

    // Obține transcript
    let transcript = '';
    let translatedTranscript = '';
    try {
      transcript = await getTranscript(videoId);
      if (transcript) {
        translatedTranscript = await translateWithGPT4(transcript);
      }
    } catch (transcriptError) {
      console.log('Transcript not available:', transcriptError.message);
    }

    res.json({
      success: true,
      download: downloadData,
      transcript: transcript,
      translatedTranscript: translatedTranscript,
      videoId: videoId,
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      error: error.message || 'Eroare la procesare',
      details: error.response?.data || null,
    });
  }
});

// Funcție pentru extragere video ID
function extractVideoId(url) {
  const regexes = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^?&\n]+)/,
  ];

  for (const regex of regexes) {
    const match = url.match(regex);
    if (match) return match[1];
  }
  return null;
}

// Obține transcript de pe YouTube
async function getTranscript(videoId) {
  try {
    const response = await axios.get(
      'https://www.youtube.com/youtubei/v1/get_transcript',
      {
        params: {
          videoId: videoId,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data?.responseContext) {
      // Parse transcript
      const transcriptData = response.data.responseContext;
      return JSON.stringify(transcriptData);
    }
    return '';
  } catch (error) {
    console.log('Transcript fetch failed, trying alternative method...');
    // Alternativă: foloseşti youtube-transcript npm package
    return '';
  }
}

// Traduce cu GPT-4 o-mini
async function translateWithGPT4(text) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Ești un traducător profesionist. Traduce următorul text din engleză în română. Păstrează formatul și sensul original.',
          },
          {
            role: 'user',
            content: `Traduce acest transcript:\n\n${text.substring(0, 3000)}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('GPT-4 translation error:', error.message);
    throw error;
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});