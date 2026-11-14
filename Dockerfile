# Plinth in a container (docs/docker.md): the npm CLI's prebuilt Worker, run by wrangler dev
# (workerd) with D1 and R2 on the /data volume.
#
#   docker build -t plinth .
#   docker run -p 127.0.0.1:8788:8788 -e PLINTH_EMAIL=you@example.com -v plinth-data:/data plinth
#
# Builds for linux/amd64 and linux/arm64. The JavaScript is built once on the build machine's own
# platform; only the production dependencies (workerd and esbuild are native) are installed per
# target platform. Base images are pinned by version and digest.

ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
ARG CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba

# ---------- build: the Worker bundle, the web app and the CLI runtime/ ----------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    WRANGLER_SEND_METRICS=false \
    CI=true
# pnpm at the version package.json pins in "packageManager".
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=plinth-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@mr0b0t0/plinth
# What the deploy stage needs: the workspace manifests and the built CLI package.
RUN mkdir /manifests \
 && cp --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc \
      apps/web/package.json apps/worker/package.json packages/shared/package.json \
      e2e/package.json /manifests/ \
 && cp -r --parents packages/cli/package.json packages/cli/README.md packages/cli/bin \
      packages/cli/runtime /manifests/

# ---------- deploy: the CLI package with its production dependencies, for the target platform ----------
FROM ${NODE_IMAGE} AS deploy
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /src
COPY --from=build /manifests/ ./
RUN --mount=type=cache,id=plinth-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
 && pnpm --filter @mr0b0t0/plinth deploy --prod --legacy /app
# workerd's and esbuild's install scripts copy the native binary from the platform package into
# their own bin/ (150 MB for workerd). Their libraries run the platform package's copy, so the
# duplicate becomes a symlink. sharp's musl builds never load on this glibc image.
RUN set -eu; cd /app/node_modules/.pnpm; \
    link() { \
      native=$(ls -d $2); [ "$(echo "$native" | wc -l)" = 1 ]; \
      for dup in $1; do cmp -s "$dup" "$native"; ln -sf "$native" "$dup"; done; \
    }; \
    link "workerd@*/node_modules/workerd/bin/workerd" \
         "$PWD/@cloudflare+workerd-linux-*/node_modules/@cloudflare/workerd-linux-*/bin/workerd"; \
    link "esbuild@*/node_modules/esbuild/bin/esbuild" \
         "$PWD/@esbuild+linux-*/node_modules/@esbuild/linux-*/bin/esbuild"; \
    rm -rf ./@img+sharp-linuxmusl-* ./@img+sharp-libvips-linuxmusl-*; \
    chmod 755 /app/bin/plinth.mjs
COPY --chmod=755 docker/entrypoint.sh docker/configure.mjs /app/docker/

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

# ---------- runtime ----------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Plinth" \
      org.opencontainers.image.description="A home for the HTML artifacts AI agents publish, run on your own machine" \
      org.opencontainers.image.source="https://github.com/mr0b0t0/plinth" \
      org.opencontainers.image.url="https://github.com/mr0b0t0/plinth" \
      org.opencontainers.image.documentation="https://github.com/mr0b0t0/plinth/blob/main/docs/docker.md" \
      org.opencontainers.image.licenses="MIT"
# FORCE_COLOR=0: plain text in `docker logs`, without terminal colour codes.
ENV NODE_ENV=production \
    PLINTH_HOME=/data \
    WRANGLER_SEND_METRICS=false \
    FORCE_COLOR=0
# cloudflared for PLINTH_TUNNEL=true, and a CA bundle: the slim Node image has none, and workerd
# (email providers' APIs) and cloudflared verify TLS against the system store.
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=cloudflared /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=deploy /app /app
# wrangler caches the Request.cf object in .wrangler/ beside the bundled runtime: the one place
# under /app the node user may write.
RUN ln -s /app/bin/plinth.mjs /usr/local/bin/plinth \
 && mkdir /app/runtime/.wrangler \
 && chown node:node /app/runtime/.wrangler \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod 700 /data
# The image's own node user (uid 1000). The app files stay root-owned and read-only to it.
USER node
WORKDIR /data
VOLUME /data
EXPOSE 8788
# `plinth status` asks /healthz with the instance's own Host header (the Worker routes by host).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["plinth", "status"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
