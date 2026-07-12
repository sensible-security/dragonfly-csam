# Dragonfly CSAM — containerized build (AGENTS.md §1: denoland/deno base,
# dependency-layer caching, non-root deno user).
FROM denoland/deno:2.9.2

WORKDIR /app

# Dependency layer: cache npm/jsr installs until the manifests change.
COPY deno.json deno.lock ./
RUN deno install

# Application source.
COPY . .

# Production build (vite → _fresh/). Pre-create the data directory so a fresh
# named volume mounted at /app/data inherits deno ownership and is writable by
# the non-root user (bind mounts still need a host-side chown — see DEPLOYMENT.md).
RUN deno task build \
  && mkdir -p /app/data \
  && chown -R deno:deno /app

# Run as the non-root deno user provided by the base image.
USER deno

# The embedded Turso DB file lives here; mount a volume to persist it.
ENV DRAGONFLY_DB_PATH=/app/data/dragonfly.db
VOLUME ["/app/data"]

EXPOSE 8000

# `deno task serve` runs `deno serve` with the minimal permission set the Turso
# client needs (--allow-ffi/read/write/env) plus --allow-net to bind the port,
# per spikes/turso/FINDINGS.md — no blanket -A.
CMD ["deno", "task", "serve"]
