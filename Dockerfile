FROM node:20-slim

# Install Ghostscript
RUN apt-get update && \
    apt-get install -y ghostscript --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
