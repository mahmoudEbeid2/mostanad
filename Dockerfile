# Base Image
FROM node:25-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy project files
COPY . .

# Generate Prisma Client at build time
RUN npx prisma generate

# Fix line endings and permissions for start.sh
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

EXPOSE 3000

CMD ["sh", "./start.sh"]
