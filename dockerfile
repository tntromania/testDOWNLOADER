# Folosim Debian 12 (Bookworm)
FROM node:20-bookworm

# 1. Instalăm Python și yt-dlp (necesar DOAR pentru titlu și transcript, nu video)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-full \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalăm yt-dlp
RUN python3 -m pip install -U yt-dlp --break-system-packages

WORKDIR /app

# 3. Copiem fișierele de dependințe
COPY package*.json ./
RUN npm install --production

# 4. Copiem codul sursă
COPY . .

# 5. Expunem portul
EXPOSE 3000

# 6. Pornim serverul
CMD ["node", "server.js"]