FROM node:18-slim

# Instalăm dependențele necesare + Python pentru yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instalăm yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copiem fișierele de configurare
COPY package*.json ./
RUN npm install --production

# Copiem RESTUL fișierelor (inclusiv cookies.txt, server.js, folderul public)
COPY . .

# Verificăm că avem cookies (opțional, pentru debugging la build)
RUN ls -la /app

EXPOSE 3003

CMD ["node", "server.js"]