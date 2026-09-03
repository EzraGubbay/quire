# syntax=docker/dockerfile:1.7
# Build context is the repo root. Produces a small standalone Next.js image for linux/arm64 and amd64.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build
# pdf.js loads @napi-rs/canvas at runtime by name; Next's file tracer cannot follow that, so bundle the
# package (and its platform binary) with pnpm's symlink layout intact for the runtime stage.
RUN cd /repo/node_modules && tar chf /tmp/canvas.tar $(ls -d .pnpm/@napi-rs+canvas*)

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 1001 quire && useradd -u 1001 -g quire -m quire \
  && mkdir -p /data/files && chown quire:quire /data/files
WORKDIR /app
COPY --from=build --chown=quire:quire /repo/apps/web/.next/standalone ./
COPY --from=build --chown=quire:quire /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=quire:quire /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=quire:quire /repo/apps/web/drizzle ./apps/web/drizzle
COPY --from=build /tmp/canvas.tar /tmp/canvas.tar
RUN mkdir -p node_modules/@napi-rs && tar xf /tmp/canvas.tar -C node_modules && rm /tmp/canvas.tar \
  && ln -s ../.pnpm/$(ls node_modules/.pnpm | grep '^@napi-rs+canvas@' | head -1)/node_modules/@napi-rs/canvas node_modules/@napi-rs/canvas \
  && chown -R quire:quire node_modules/@napi-rs node_modules/.pnpm
USER quire
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
