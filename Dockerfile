# Cloud Run image for the API (api/ handlers served by server/server.mjs).
# The site itself stays on GitHub Pages.
FROM node:22-slim
# ffmpeg cuts the clips for compilation mode (api/compile.js).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api ./api
COPY server ./server
COPY scripts ./scripts
# api/ is written as ES modules.
RUN echo '{"type":"module"}' > package.json
ENV NODE_ENV=production
USER node
CMD ["node", "server/server.mjs"]
