# syntax=docker/dockerfile:1
# ---- deps: build native modules (better-sqlite3) once
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force

# ---- runtime
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/app.db \
    FILE_DIR=/data/files
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node samples ./samples
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
