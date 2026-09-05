# syntax=docker/dockerfile:1
# =============================================================================
# gw-mailbox — single container: PocketBase 0.39 (API + hooks + cron) serving
# the Svelte SPA from pb_public on the same origin. No CORS, one deployment.
# Build context = repo root (PocketBase binary is committed to the repo).
#
# IMPORTANT: every PB directory is passed as an ABSOLUTE path — container
# runtime CWD is not guaranteed to be /app (observed with Dokploy).
# =============================================================================

# ---- stage 1: build the Svelte 5 / M3 frontend ----------------------------
FROM node:22-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
# VITE_PB_URL is intentionally unset: the SPA talks to the same origin (/api),
# which PocketBase serves. Override at build-time only if you split hosts.
ARG VITE_PB_URL=""
ENV VITE_PB_URL=$VITE_PB_URL
RUN npm run build

# ---- stage 2: runtime ------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

# PocketBase 0.39 binary (kept in the repo for reproducible builds)
COPY --chmod=0755 pocketbase /usr/local/bin/pocketbase

# Backend: schema migrations + JS hooks
COPY pb_migrations /app/pb_migrations
COPY pb_hooks /app/pb_hooks

# Frontend SPA served by PocketBase at the domain root
COPY --from=ui /ui/dist /app/pb_public

RUN mkdir -p /app/pb_data

ENV PB_ENCRYPTION_KEY="" \
    MAILBOX_SEED_DEMO=1 \
    MAILBOX_TIMEZONE=UTC
EXPOSE 8090
VOLUME ["/app/pb_data"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/api/health || exit 1

CMD ["/usr/local/bin/pocketbase", "serve", "--http=0.0.0.0:8090", \
     "--dir=/app/pb_data", "--publicDir=/app/pb_public", \
     "--hooksDir=/app/pb_hooks", "--migrationsDir=/app/pb_migrations"]
