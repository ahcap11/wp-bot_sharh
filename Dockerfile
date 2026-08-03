# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:20-alpine AS builder

# Avoid downloading Chromium for the (currently unused) puppeteer dependency.
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PORT=8080
ENV HEALTH_PORT=3001

WORKDIR /app

# Install only production dependencies.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from the build stage.
COPY --from=builder /app/dist ./dist

# Persisted WhatsApp session and app state live here; mount volumes to keep
# them across restarts/redeploys. /app/data is the mount point for the Railway
# volume (WHATSAPP_AUTH_DIR + PERSISTENCE_PATH live under it).
RUN mkdir -p /app/.whatsapp-session /app/.state /app/logs /app/data

# NOTE: We run as root. Railway mounts volumes owned by root, so a non-root
# user cannot create directories inside the mount (EACCES). Running as root
# avoids that. Railway containers are isolated, so this is acceptable here.

EXPOSE 8080 3001


# Liveness check against the built-in health server (now on $PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
