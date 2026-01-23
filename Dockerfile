# Folosește Debian Slim - mai suportat față de Alpine pentru aplicatii complexe
FROM node:18-bullseye-slim

# Actualizează lista de pachete și instalează Python, pip și ffmpeg
RUN apt-get update && apt-get install -y \
  python3 \
  python3-venv \
  python3-pip \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Creează mediu virtual Python și instalează yt-dlp
RUN python3 -m venv /venv && \
  /venv/bin/pip install --upgrade pip && \
  /venv/bin/pip install yt-dlp

# Setează directorul de lucru
WORKDIR /app

# Copiază fișierele aplicației
COPY package*.json ./
COPY server.js ./
COPY public ./public

# Instalează dependințele Node.js
RUN npm install --production

# Configurează path-ul pentru mediu virtual
ENV PATH="/venv/bin:$PATH"

# Expune portul aplicației
EXPOSE 3000

# Pornește aplicația
CMD ["node", "server.js"]