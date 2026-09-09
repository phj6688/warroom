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

# Marks this artifact as a deployed one, so lib/auth.js refuses to honour
# WAR_ROOM_ALLOW_ANONYMOUS in a container built from this file. It is a default,
# not a seal: an image ENV loses to compose `environment:` / `env_file:` and to
# `docker run --env`, so a run that sets NODE_ENV to something else alongside the
# opt-in does get an open instance. That takes two deliberate variables and never
# an absence of one, which is the property that matters here. Set after
# `npm ci --production` so the install is unaffected.
ENV NODE_ENV=production

# Baked into the image rather than supplied at run time. A runtime value has to
# be re-supplied on every `docker compose up`, and one that is forgotten silently
# drops the build beacon from the served page, which costs the screenshot gate
# its provenance without anything visibly breaking.
ARG BUILD_SHA=""
ENV BUILD_SHA=$BUILD_SHA

EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
