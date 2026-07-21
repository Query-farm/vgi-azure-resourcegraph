# Copyright 2026 Query Farm LLC - https://query.farm
#
# Single image serving BOTH transports of the vgi-azure-resourcegraph worker:
#   docker run ... IMG            -> HTTP server on $PORT (default 8000; /health, VGI RPC)
#   docker run -i ... IMG stdio   -> stdio worker DuckDB spawns on-host
# See docker-entrypoint.sh. Credential-gated ARM connector: /health needs no azure
# creds; resourcegraph_query requires a live azure_graph secret at query time. No
# persistent state volume.
# syntax=docker/dockerfile:1
FROM oven/bun:1

ARG VERSION=0.0.0
ARG GIT_COMMIT=unknown
ARG SOURCE_URL=https://github.com/Query-farm/vgi-azure-resourcegraph

LABEL org.opencontainers.image.title="vgi-azure-resourcegraph" \
      org.opencontainers.image.description="Azure Resource Graph (KQL) queries over your ARM estate as a VGI worker for DuckDB/SQL (stdio + HTTP)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.licenses="MIT" \
      farm.query.vgi.transports='["http","stdio"]'

ENV PORT=8000 \
    NODE_ENV=production

WORKDIR /app

# curl backs the HEALTHCHECK and the CI /health smoke; the driver uses fetch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
