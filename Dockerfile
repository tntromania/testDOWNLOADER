# Folosește imaginea oficială Node.js bazată pe Debian Slim
FROM node:18-bullseye-slim

# Actualizează lista de pachete și instalează Python, pip și ffmpeg
RUN apt-get update && apt-get install -y python3-pip ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Creează și activează un mediu virtual Python
RUN python3 -m venv /venv && \
    /venv/bin/pip install --upgrade pip && \
    /venv/bin/pip install yt-dlp

# Setează directorul ca fiind directorul de lucru în container
WORKDIR /app

# Copiază fișierele aplicației în container
COPY package*.json ./
COPY server.js ./
COPY public ./public

# Instalează dependențele Node.js pentru producție
RUN npm install --production

# Configurează variabilele PATH pentru mediu virtual Python
ENV PATH="/venv/bin:$PATH"

# Expune portul aplicației
EXPOSE 3000

# Pornește aplicația
CMD ["node", "server.js"]