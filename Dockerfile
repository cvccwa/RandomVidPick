# Cloud Run image for the API (api/ handlers served by server/server.mjs).
# The site itself stays on GitHub Pages.
FROM node:22-slim
WORKDIR /app
COPY api ./api
COPY server ./server
# api/ is written as ES modules; Vercel infers that, plain Node needs telling.
RUN echo '{"type":"module"}' > package.json
ENV NODE_ENV=production
USER node
CMD ["node", "server/server.mjs"]
