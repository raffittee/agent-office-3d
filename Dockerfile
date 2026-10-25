# syntax=docker/dockerfile:1
#
# Agent Office in a container (P8-05). Use `npm run docker:up` (scripts/docker-up.ts): it finds your agents' folders
# on the host and writes docker-compose.override.yml with READ-ONLY mounts of only the folders the office reads.
# This Dockerfile alone mounts nothing from the host.
#
# Stage 1 builds the client (Vite) and bundles the server (esbuild) into dist/.
FROM node:22.12-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Stage 2: the server has no runtime dependencies (node:* only), so dist/ and package.json are all it needs.
FROM node:22.12-alpine AS runtime
ENV NODE_ENV=production \
    AGENT_OFFICE_HOST=0.0.0.0 \
    AGENT_OFFICE_PORT=4848 \
    AGENT_OFFICE_IN_DOCKER=1 \
    AGENT_OFFICE_DATA_DIR=/data
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
# Agent Office's own state (persisted names, room aliases). The only writable place.
RUN mkdir -p /data && chown node:node /data
# An unprivileged user; the code stays root-owned, so the process can't change it.
USER node
EXPOSE 4848
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4848/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
