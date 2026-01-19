FROM node:18-alpine

WORKDIR /app

# Copiem lista de dependinte
COPY package*.json ./

# Instalam dependintele (inclusiv youtube-transcript)
RUN npm install

# Copiem restul codului
COPY . .

# Expunem portul
EXPOSE 3000

# Pornim serverul
CMD ["node", "server.js"]