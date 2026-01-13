FROM node:18-slim

# Instalăm Python, FFmpeg și curl (necesare pentru yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instalăm yt-dlp oficial
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Expunem portul 3003 (cel din server.js)
EXPOSE 3003

CMD ["node", "server.js"]