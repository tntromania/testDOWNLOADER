FROM node:18-slim

# 1. Instalăm Python, FFmpeg (CRITIC pentru Shorts) și dependențele necesare
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalăm yt-dlp (ultima versiune oficială)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# 3. Copiem fișierele de dependențe
COPY package*.json ./
RUN npm install --production

# 4. Copiem restul aplicației (server.js, cookies.txt etc.)
COPY . .

# 5. EXPUNEM PORTUL 3000 (Același ca în server.js)
EXPOSE 3000

# 6. Pornim serverul
CMD ["node", "server.js"]