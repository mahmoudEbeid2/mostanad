#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

echo "⏳ Starting Mostanad API Initialization..."

echo "🔄 Generating Prisma Client..."
npx prisma generate

if [ "$NODE_ENV" = "production" ]; then
  echo "🔄 Syncing database schema (db push)..."
  npx prisma db push --accept-data-loss

  echo "🌱 Seeding initial data..."
  npx prisma db seed

  echo "🚀 Starting Mostanad API server in PRODUCTION mode..."
  exec npm start
else
  echo "🔄 Syncing database schema (db push)..."
  npx prisma db push --accept-data-loss

  echo "🌱 Seeding initial data..."
  npx prisma db seed

  echo "🚀 Starting Mostanad API server in DEVELOPMENT mode..."
  exec npm run dev
fi
