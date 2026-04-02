FROM node:22-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts=false
COPY server.js db.js mcp-server.js mcp-server.mjs ./
COPY lib ./lib/
COPY mcp ./mcp/
COPY prompts ./prompts/
COPY migrations ./migrations/
COPY public ./public/
RUN mkdir -p data uploads
EXPOSE 8090
CMD ["node", "server.js"]
