import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Env variables are now directly fetched from the system (e.g., Coolify/Environment variables)
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Route for downloading video and getting transcript
app.post('/api/download', async (req, res) => {
  try {
    // Extract the URL from the request body
    const { url } = req.body;

    if (!url) {
      console.log('Client did not provide a URL.');
      return res.status(400).json({ error: 'YouTube URL este obligatoriu' });
    }

    // Extract the video ID from the URL
    const videoId = extractVideoId(url);
    if (!videoId) {
      console.log('Invalid YouTube URL:', url);
      return res.status(400).json({ error: 'URL YouTube invalid' });
    }

    console.log(`Processing video ID: ${videoId}`);

    // Contact RapidAPI to get video metadata
    let videoData;
    try {
      console.log('Sending request to RapidAPI for video metadata...');
      const videoResponse = await axios.get(
        `https://${RAPIDAPI_HOST}/video.php`,
        {
          params: {
            id: videoId,
          },
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': RAPIDAPI_HOST,
          },
        }
      );
      videoData = videoResponse.data;

      console.log('Received video metadata from RapidAPI:', videoData);
    } catch (error) {
      console.error('Error while fetching video metadata from RapidAPI:');
      console.error(error.response?.data || error.message);
      return res.status(500).json({
        error: 'Eroare la obținerea informațiilor video',
        details: error.response?.data || error.message,
      });
    }

    // Ensure video response is successful
    if (videoData.status !== 'success') {
      console.error('RapidAPI video metadata response was not successful:', videoData);
      return res.status(500).json({
        error: 'Eroare la obținerea informațiilor video',
        details: videoData,
      });
    }

    // Contact RapidAPI to get download streams
    let downloadData;
    try {
      console.log('Sending request to RapidAPI for download streams...');
      const downloadResponse = await axios.get(
        `https://${RAPIDAPI_HOST}/download.php`,
        {
          params: {
            id: videoId,
          },
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': RAPIDAPI_HOST,
          },
        }
      );
      downloadData = downloadResponse.data;

      console.log('Received download streams from RapidAPI:', downloadData);
    } catch (error) {
      console.error('Error while fetching download streams from RapidAPI:');
      console.error(error.response?.data || error.message);
      return res.status(500).json({
        error: 'Eroare la obținerea streamurilor de descărcare',
        details: error.response?.data || error.message,
      });
    }

    // Ensure download response is successful
    if (downloadData.status !== 'success') {
      console.error('RapidAPI download response was not successful:', downloadData);
      return res.status(500).json({
        error: 'Eroare la obținerea streamurilor de descărcare',
        details: downloadData,
      });
    }

    // Optionally fetch transcript and translation (asynchronous)
    let transcript = '';
    let translatedTranscript = '';
    try {
      transcript = await getTranscript(videoId);
      if (transcript) {
        translatedTranscript = await translateWithGPT4(transcript);
      }
    } catch (transcriptError) {
      console.log('Transcript or translation not available:', transcriptError.message);
    }

    // Return response to client
    res.json({
      success: true,
      videoInfo: videoData,
      download: downloadData,
      transcript: transcript,
      translatedTranscript: translatedTranscript,
      videoId: videoId,
    });
  } catch (error) {
    console.error('Unexpected server error:', error.message);
    res.status(500).json({
      error: error.message || 'Eroare la procesare.',
    });
  }
});

// Extract video ID from a YouTube URL
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

// Fetch YouTube transcript (optional functionality for testing with AI translation)
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
      const transcriptData = response.data.responseContext;
      return JSON.stringify(transcriptData);
    }
    return '';
  } catch (error) {
    console.log('Transcript fetch failed:', error.message);
    return '';
  }
}

// Translate text with GPT-4 model
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
    console.error('Translation error with GPT-4:', error.message);
    return '';
  }
}

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});