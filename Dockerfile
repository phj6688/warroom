FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts=false
COPY server.js mcp-server.js ./
COPY public ./public/
RUN mkdir -p data uploads
EXPOSE 8090
CMD ["node", "server.js"]
