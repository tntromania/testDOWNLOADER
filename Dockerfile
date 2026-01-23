FROM node:18-alpine

# Instalează yt-dlp și toate dependențele necesare
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    py3-pip \
    && pip install yt-dlp

# Setează directorul de lucru
WORKDIR /app

# Copiază toate fișierele aplicației în container
COPY package*.json ./
COPY server.js ./
COPY public ./public

# Instalează dependențele aplicației Node.js
RUN npm install --production

# Expune portul aplicației
EXPOSE 3000

# Pornește aplicația
CMD ["node", "server.js"]