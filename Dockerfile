# Base Image
FROM node:25-alpine

WORKDIR /app

# No Chromium and no fonts here: every render runs in the cert-renderer image
# (docker/cert-renderer, CERTIFICATES_V2_PLAN.md §5.3). Nothing else in the API
# or the workers draws text: fontCoverage parses embedded fonts with fontkit and
# pixelDiff only decodes/encodes PNGs (@napi-rs/canvas).
# ghostscript, imagemagick and librsvg removed (review #21): no caller since V1 certificates were retired
RUN apk add --no-cache ca-certificates

# puppeteer stays in package.json for the tests; never download a browser here
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm ci

# Copy project files
COPY . .

# Generate Prisma Client at build time
RUN npx prisma generate

# Fix line endings and permissions for start.sh
RUN sed -i 's/\r$//' ./scripts/start.sh && chmod +x ./scripts/start.sh

EXPOSE 3000

CMD ["sh", "./scripts/start.sh"]
