# Base Image
FROM node:25-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Generate Prisma Client at build time
RUN npx prisma generate


EXPOSE 3000

CMD ["npm", "run", "dev"]
