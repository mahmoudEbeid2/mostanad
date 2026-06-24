#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

echo "⏳ Starting Mostanad API Initialization..."

if [ "$NODE_ENV" = "production" ]; then
  echo "🔄 Syncing database schema (migrate deploy)..."
  npx prisma migrate deploy

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
