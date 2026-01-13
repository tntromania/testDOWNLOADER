FROM node18-slim

# Instalăm Python, FFmpeg și curl (necesare pentru yt-dlp)
RUN apt-get update && apt-get install -y 
    python3 
    python3-pip 
    ffmpeg 
    curl 
    && rm -rf varlibaptlists

# Instalăm yt-dlp oficial
RUN curl -L httpsgithub.comyt-dlpyt-dlpreleaseslatestdownloadyt-dlp -o usrlocalbinyt-dlp
RUN chmod a+rx usrlocalbinyt-dlp

WORKDIR app

COPY package.json .
RUN npm install

COPY . .

# Expunem portul (tu ai 3003 în server.js)
EXPOSE 3003

CMD [node, server.js]