# Folosim Debian 12 (Bookworm) care are Python 3.11 nativ
FROM node:20-bookworm

# 1. Instalăm Python, Pip și FFmpeg
# 'python3-full' este necesar pe Bookworm pentru venv
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-full \
    ffmpeg \
    atomicparsley \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalăm yt-dlp prin PIP (cea mai nouă versiune)
# Folosim --break-system-packages pentru că suntem în Docker și nu ne pasă de mediul izolat
RUN python3 -m pip install -U yt-dlp --break-system-packages

# Verificăm unde s-a instalat (de obicei în /usr/local/bin)
RUN which yt-dlp

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