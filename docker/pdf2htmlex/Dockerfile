# pdf2htmlEX conversion service (Certificates V2).
# Separate image on purpose: the app image is node:25-alpine and pdf2htmlEX
# ships only Ubuntu/glibc builds — it cannot run on Alpine (musl).
# Built from the official GitHub release .deb (verified on Ubuntu 24.04) instead
# of a Docker Hub tag, so the version is pinned here.
FROM ubuntu:24.04

ARG P2H_DEB_URL=https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.deb

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl nodejs \
 && curl -fsSL -o /tmp/pdf2htmlEX.deb "$P2H_DEB_URL" \
 && apt-get install -y --no-install-recommends /tmp/pdf2htmlEX.deb \
 && rm -f /tmp/pdf2htmlEX.deb \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
# package.json only declares "type": "module" — server.js is ESM and apt's
# Node 18 would otherwise parse it as CommonJS and crash-loop.
COPY package.json server.js ./

ENV PORT=5000 \
    PDF2HTMLEX_BIN=pdf2htmlEX

RUN useradd --system --no-create-home converter
USER converter

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
