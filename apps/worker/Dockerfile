FROM oven/bun:1.3.11
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
# ponytail: installs every workspace's deps, web's included. Filter the install once image size matters.
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["sh", "-c", "bun ../../packages/db/src/migrate.ts && exec bun src/main.ts"]
