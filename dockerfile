# Folosim versiunea FULL de Node/Debian, nu slim
FROM node:18-bullseye

# 1. Instalăm Python3, Pip și FFmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    atomicparsley \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalăm yt-dlp prin PIP (Mult mai stabil decât curl binary)
# Asta ne asigură că avem ultima versiune compatibilă cu Python-ul instalat
RUN python3 -m pip install -U yt-dlp

# Facem un symlink ca să fim siguri că server.js îl găsește la calea veche
RUN ln -s /usr/local/bin/yt-dlp /usr/bin/yt-dlp

WORKDIR /app

# 3. Copiem fișierele de configurare
COPY package*.json ./
RUN npm install --production

# 4. Copiem restul aplicației
COPY . .

# 5. Setăm portul
EXPOSE 3000

# 6. Pornim
CMD ["node", "server.js"]