# war-room — Agent Context

## Purpose


## Deploy
#1 [internal] load local bake definitions
#1 reading from stdin 500B done
#1 DONE 0.0s

#2 [internal] load build definition from Dockerfile
#2 transferring dockerfile: 316B done
#2 DONE 0.0s

#3 [internal] load metadata for docker.io/library/node:22-alpine
#3 DONE 0.4s

#4 [internal] load .dockerignore
#4 transferring context: 63B done
#4 DONE 0.0s

#5 [1/8] FROM docker.io/library/node:22-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34
#5 DONE 0.0s

#6 [internal] load build context
#6 transferring context: 245B done
#6 DONE 0.0s

#7 [5/8] RUN npm ci --production --ignore-scripts=false
#7 CACHED

#8 [3/8] WORKDIR /app
#8 CACHED

#9 [7/8] COPY public ./public/
#9 CACHED

#10 [6/8] COPY server.js mcp-server.js ./
#10 CACHED

#11 [2/8] RUN apk add --no-cache python3 make g++
#11 CACHED

#12 [4/8] COPY package.json package-lock.json ./
#12 CACHED

#13 [8/8] RUN mkdir -p data uploads
#13 CACHED

#14 exporting to image
#14 exporting layers done
#14 writing image sha256:7fc71d1b01a62c17e3ed1bdce8f029d6f3fc37acb4773a8d5967e2bee8a204fe done
#14 naming to docker.io/library/war-room-war-room done
#14 DONE 0.0s

#15 resolving provenance for metadata file
#15 DONE 0.0s

## Key endpoints
See server.js — search for 'app.get' and 'app.post'

## Database
SQLite at /app/data/ (Docker volume)

## Recent changes
<!-- Agents: update this section after each session -->

## Known issues
<!-- Agents: update this section as discovered -->
