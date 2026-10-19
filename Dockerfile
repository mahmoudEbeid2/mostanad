# Base Image
FROM node:25-alpine

WORKDIR /app

# Copy package files and install dependencies
# ghostscript, imagemagick and librsvg removed (review #21): no caller since V1 certificates were retired
RUN apk add --no-cache fontconfig ttf-dejavu chromium nss freetype harfbuzz ca-certificates ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

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
