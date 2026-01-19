const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Verifică dacă API key-ul există
if (!process.env.RAPIDAPI_KEY) {
  console.error('ERROR: RAPIDAPI_KEY nu este setat în variabilele de mediu Coolify');
  process.exit(1);
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const API_HOST = 'youtube-video-and-shorts-downloader.p.rapidapi.com';
const BASE_URL = `https://${API_HOST}`;

// Headers pentru RapidAPI
const getHeaders = () => ({
  'X-RapidAPI-Key': RAPIDAPI_KEY,
  'X-RapidAPI-Host': API_HOST
});

// Route: Obține informații despre video
app.get('/api/video-info', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Video ID este necesar' });
    }

    const response = await axios.get(`${BASE_URL}/video.php`, {
      params: { id, lang: 'ro', geo: 'RO' },
      headers: getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    console.error('Eroare la obținerea informațiilor video:', error.message);
    res.status(500).json({ 
      error: 'Eroare la obținerea informațiilor video',
      details: error.response?.data || error.message 
    });
  }
});

// Route: Obține stream-urile de download
app.get('/api/download', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Video ID este necesar' });
    }

    const response = await axios.get(`${BASE_URL}/download.php`, {
      params: { id },
      headers: getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    console.error('Eroare la obținerea link-urilor de download:', error.message);
    res.status(500).json({ 
      error: 'Eroare la obținerea link-urilor de download',
      details: error.response?.data || error.message 
    });
  }
});

// Route: Caută videoclipuri
app.get('/api/search', async (req, res) => {
  try {
    const { query, order = 'relevance', type = 'video' } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query-ul de căutare este necesar' });
    }

    const response = await axios.get(`${BASE_URL}/search.php`, {
      params: { query, order, type, lang: 'ro', geo: 'RO' },
      headers: getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    console.error('Eroare la căutare:', error.message);
    res.status(500).json({ 
      error: 'Eroare la căutare',
      details: error.response?.data || error.message 
    });
  }
});

// Route: Obține videoclipuri trending
app.get('/api/trending', async (req, res) => {
  try {
    const { type = 'now' } = req.query;

    const response = await axios.get(`${BASE_URL}/trending.php`, {
      params: { type, lang: 'ro', geo: 'RO' },
      headers: getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    console.error('Eroare la obținerea videoclipurilor trending:', error.message);
    res.status(500).json({ 
      error: 'Eroare la obținerea videoclipurilor trending',
      details: error.response?.data || error.message 
    });
  }
});

// Route: Rezolvă URL YouTube
app.get('/api/resolve', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL-ul este necesar' });
    }

    const response = await axios.get(`${BASE_URL}/resolve.php`, {
      params: { url },
      headers: getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    console.error('Eroare la rezolvarea URL-ului:', error.message);
    res.status(500).json({ 
      error: 'Eroare la rezolvarea URL-ului',
      details: error.response?.data || error.message 
    });
  }
});

// Servește index.html pentru toate celelalte rute
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Serverul rulează pe portul ${PORT}`);
  console.log(`🌐 Accesează: http://localhost:${PORT}`);
});