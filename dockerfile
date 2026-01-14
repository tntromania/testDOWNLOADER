FROM node:18-slim

# =========================
# DEPENDINȚE SISTEM
# =========================
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# =========================
# INSTALL + FORCE UPDATE yt-dlp
# =========================
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY cookies.txt /app/cookies.txt


# =========================
# NODE DEPENDENCIES
# =========================
COPY package*.json ./
RUN npm install --production

# =========================
# APP FILES
# =========================
COPY . .

EXPOSE 3003

CMD ["node", "server.js"]
