FROM node:24-slim AS builder
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY . .
RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local --mount=type=cache,target=/root/.bun/install/cache bun install

ENV NODE_ENV=production
# varlock validates the whole schema during the build. Compose sets the real DATABASE_URL at runtime.
RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local cd apps/web && DATABASE_URL=postgresql://build-placeholder bun run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app

ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE 3001

# SSR chunks require workspace dependencies at runtime
WORKDIR /app/apps/web
CMD ["sh", "-c", "node ../../packages/db/src/migrate.ts && exec node .output/server/index.mjs"]
