# YouTube Transcript Downloader & Translator 📺🌐

O aplicație simplă pentru a descărca transcripturi de pe YouTube și a le traduce automat în română folosind GPT-4o mini.

## Caracteristici

- ✅ Obținere instant a transcriptului YouTube
- ✅ Traducere automată în română cu GPT-4o mini
- ✅ Interfață web simplă și intuitivă
- ✅ API REST pentru integrare
- ✅ Suport Docker

## Cerințe

- Node.js 18+ (sau Docker)
- OpenAI API Key (pentru traducere)

## Instalare & Configurare

### 1. Clonați repository-ul

```bash
git clone https://github.com/tntromania/testDOWNLOADER.git
cd testDOWNLOADER
```

### 2. Instalați dependențele

```bash
npm install
```

### 3. Configurați variabilele de mediu

Copiați fișierul `.env.example` în `.env`:

```bash
cp .env.example .env
```

Editați fișierul `.env` și adăugați cheia dvs. OpenAI API:

```
OPENAI_API_KEY=sk-your-actual-api-key-here
```

**Cum obțineți API Key:**
1. Accesați https://platform.openai.com/api-keys
2. Conectați-vă sau creați un cont
3. Creați un nou API key
4. Copiați cheia în fișierul `.env`

### 4. Porniți aplicația

```bash
npm start
```

Aplicația va rula pe http://localhost:3000

## Utilizare

### Interfață Web

1. Deschideți browserul la http://localhost:3000
2. Introduceți URL-ul unui video YouTube
3. Apăsați butonul "Obține Transcript & Traducere"
4. Așteptați procesarea (poate dura 10-30 secunde pentru traducere)
5. Veți vedea atât transcriptul original cât și traducerea în română

### API REST

**Endpoint:** `POST /api/transcript`

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:**
```json
{
  "videoId": "VIDEO_ID",
  "original": "Transcriptul original în limba originală...",
  "translated": "Transcriptul tradus în română...",
  "transcriptData": [...]
}
```

**Exemplu cURL:**
```bash
curl -X POST http://localhost:3000/api/transcript \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Docker

### Build și rulare

```bash
docker build -t youtube-transcript .
docker run -p 3000:3000 -e OPENAI_API_KEY=your_key_here youtube-transcript
```

## Limitări

- Funcționează doar pentru videoclipuri YouTube care au transcripturi disponibile
- Traducerea necesită un API key OpenAI valid
- Costurile OpenAI se aplică pentru fiecare traducere

## Troubleshooting

### "Transcript indisponibil"
- Videoclipul nu are subtitrat/transcript disponibil
- Încercați un alt video sau verificați dacă are subtitrări pe YouTube

### "API key lipsă"
- Verificați că ați configurat corect fișierul `.env`
- Asigurați-vă că ați restartat serverul după modificarea `.env`

### Erori de traducere
- Verificați că API key-ul OpenAI este valid
- Verificați că aveți credite disponibile în contul OpenAI

## Tehnologii Utilizate

- Node.js & Express
- youtube-transcript - pentru obținerea transcripturilor
- OpenAI API (GPT-4o mini) - pentru traducere
- HTML/CSS/JavaScript - interfața web

## Licență

ISC

## Contribuții

Pull request-urile sunt binevenite! Pentru schimbări majore, deschideți mai întâi un issue pentru a discuta ce doriți să schimbați.
