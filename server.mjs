import express from "express";
import cors from "cors";
import { exec } from "child_process";
import { createReadStream } from "fs";
import { pipeline } from "stream";
import { getTranscript } from "youtube-transcript";

const app = express();
app.use(express.json());
app.use(cors());

// Descărcare instant + transcript
app.post("/api/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL YouTube este obligatoriu!" });
  }

  try {
    // Validează URL și obține video ID
    const videoId = url.split("v=")[1]?.split("&")[0] || url.split("/").pop();
    if (!videoId) {
      return res.status(400).json({ error: "URL YouTube invalid." });
    }

    console.log(`Processing video: ${videoId}`);

    // Generează comanda yt-dlp pentru descărcare directă (stream prin STDOUT)
    const command = `yt-dlp -o - -f best ${url}`;
    console.log(`Executing command: ${command}`);

    // Pornire transmisie video directă
    const stream = exec(command, { maxBuffer: 1024 * 1024 * 100 });
    res.writeHead(200, {
      "Content-Disposition": `attachment; filename="video.mp4"`,
      "Content-Type": "video/mp4",
    });

    stream.stdout.pipe(res); // Conectează stream-ul direct la răspunsul HTTP
    stream.stderr.on("data", (data) => console.error(data.toString()));
    stream.on("close", () => console.log("Download complete"));

    // Obține transcript
    let transcript = [];
    try {
      transcript = await getTranscript(videoId);
    } catch (err) {
      console.log("Transcript indisponibil:", err.message);
    }

    // Traduce transcript cu GPT
    let translatedTranscript = "";
    if (transcript && transcript.length > 0) {
      translatedTranscript = await translateWithGPT(
        transcript.map((t) => t.text).join("\n")
      );
    }

    // Adaugă transcriptul tradus în răspuns sub formă de JSON metadata
    res.addTrailers({
      "x-transcript-original": JSON.stringify(transcript),
      "x-transcript-translated": translatedTranscript || "Fără traducere",
    });
  } catch (error) {
    console.error("Server error:", error.message);
    res.status(500).json({ error: "Eroare la procesare." });
  }
});

// Funcție pentru traducerea cu GPT
async function translateWithGPT(text) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Tradu următorul text din engleză în română păstrând integritatea sensului.",
          },
          {
            role: "user",
            content: text,
          },
        ],
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error("Eroare la traducere GPT:", err.message);
    return "";
  }
}

// Pornește serverul
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server pornit pe http://localhost:${PORT}`);
});