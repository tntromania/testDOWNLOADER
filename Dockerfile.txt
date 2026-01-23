FROM node:18-alpine

WORKDIR /app

# Copy files
COPY package*.json ./
COPY server.js ./
COPY public ./public

# Install dependencies
RUN npm install --production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start app
CMD ["npm", "start"]