# cert-renderer — the only image with Chromium (CERTIFICATES_V2_PLAN.md §5.3).
# Built from the REPO ROOT (compose: context ".", dockerfile this file) so the
# renderer source is the same file the API's tests and goldens exercise —
# src/services/certificates/engine/{renderer,fieldEngine.browser,renderOps,renderWire}.js
# and src/services/certificates/renderService/server.js — never a copy.
# Same base and the same Alpine Chromium + font packages the API image used to
# carry, so every measurement (calibration, round trip, pixel diffs, PDFs) is
# produced by the same browser and fonts as before the split.
FROM node:25-alpine

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates fontconfig ttf-dejavu ttf-freefont

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CERT_RENDERER_PORT=5070

WORKDIR /app
# puppeteer only (pinned to the repo's version, own lockfile)
COPY docker/cert-renderer/package.json docker/cert-renderer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY src/services/certificates/engine/renderer.js \
     src/services/certificates/engine/fieldEngine.browser.js \
     src/services/certificates/engine/renderOps.js \
     src/services/certificates/engine/renderWire.js \
     ./src/services/certificates/engine/
COPY src/services/certificates/renderService/server.js ./src/services/certificates/renderService/

RUN adduser -D renderer
USER renderer

EXPOSE 5070
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/services/certificates/renderService/server.js"]
