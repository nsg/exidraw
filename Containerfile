# node:24-bookworm-slim (multi-platform index, resolved with skopeo inspect)
FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && mkdir -p shared/node_modules server/node_modules web/node_modules

# node:24-bookworm-slim
FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/web/dist/third-party-licenses.txt ./third-party-licenses.txt
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/node_modules ./shared/node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/renderer-dist ./server/renderer-dist
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/web/package.json ./web/
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/node_modules ./web/node_modules

# Invoke the production Playwright CLI directly; the root bin can belong to
# @playwright/test, which is removed with the development dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && node node_modules/playwright/cli.js install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app \
 && mkdir -p /data \
 && chown -R app:app /data /ms-playwright

USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "try { const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/healthz', { signal: AbortSignal.timeout(4000) }); process.exit(response.ok ? 0 : 1); } catch { process.exit(1); }"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]
