# Pull the Infisical CLI binary out of the official server image
FROM infisical/infisical:v0.159.28 AS infisical-cli

FROM node:22-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts=false
COPY server.js db.js ./
COPY lib ./lib/
COPY mcp ./mcp/
COPY prompts ./prompts/
COPY migrations ./migrations/
COPY public ./public/
RUN mkdir -p data uploads

COPY --from=infisical-cli /usr/bin/infisical /usr/local/bin/infisical
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV HOME=/tmp

EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
