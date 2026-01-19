FROM node:18-alpine

WORKDIR /app

# 1. Copiem fișierele de configurare
COPY package*.json ./

# 2. Instalăm TOATE dependințele (inclusiv youtube-transcript)
RUN npm install

# 3. Copiem restul codului
COPY . .

# 4. Expunem portul și pornim
EXPOSE 3000
CMD ["node", "server.js"]