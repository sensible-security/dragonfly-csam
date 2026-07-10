# Dragonfly CSAM — containerized build (AGENTS.md §1: denoland/deno base,
# dependency-layer caching, non-root deno user).
FROM denoland/deno:2.9.2

WORKDIR /app

# Dependency layer: cache npm/jsr installs until the manifests change.
COPY deno.json deno.lock ./
RUN deno install

# Application source.
COPY . .

# Production build (vite → _fresh/).
RUN deno task build && chown -R deno:deno /app

# Run as the non-root deno user provided by the base image.
USER deno

EXPOSE 8000

CMD ["deno", "task", "serve"]
