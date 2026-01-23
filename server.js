import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { YoutubeTranscript } from "youtube-transcript";
import OpenAI from "openai";

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static("public"));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Extract video ID from YouTube URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

// Endpoint pentru a obține transcriptul și traducerea
app.post("/api/transcript", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL YouTube este obligatoriu!" });
  }

  try {
    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: "URL YouTube invalid." });
    }

    console.log(`Processing transcript for video: ${videoId}`);

    // Get transcript
    const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
    
    if (!transcriptData || transcriptData.length === 0) {
      return res.status(404).json({ error: "Transcript indisponibil pentru acest video." });
    }

    // Combine transcript text
    const originalText = transcriptData.map((item) => item.text).join(" ");

    console.log(`Transcript obținut, lungime: ${originalText.length} caractere`);

    // Translate with GPT-4o mini
    let translatedText = "";
    if (process.env.OPENAI_API_KEY) {
      console.log("Traducere transcript cu GPT-4o mini...");
      translatedText = await translateWithGPT(originalText);
    } else {
      console.warn("OPENAI_API_KEY nu este setat, traducerea este omisă.");
      translatedText = "API key lipsă - traducerea nu a putut fi efectuată.";
    }

    // Return both original and translated
    res.json({
      videoId,
      original: originalText,
      translated: translatedText,
      transcriptData: transcriptData.slice(0, 10), // First 10 items with timestamps
    });
  } catch (error) {
    console.error("Server error:", error.message);
    res.status(500).json({ error: "Eroare la procesare: " + error.message });
  }
});

// Translate text using GPT-4o mini
async function translateWithGPT(text) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Ești un translator profesionist. Traduce textul următor în limba română, păstrând sensul original și folosind un limbaj natural.",
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.3,
    });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error("Eroare la traducere GPT:", err.message);
    throw new Error("Traducerea a eșuat: " + err.message);
  }
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Server funcționează!" });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server pornit pe http://localhost:${PORT}`);
  console.log(`📝 API disponibil la http://localhost:${PORT}/api/transcript`);
});