#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

echo "⏳ Starting Mostanad API Initialization..."

echo "🔄 Syncing database schema..."
npx prisma db push --accept-data-loss

echo "🌱 Seeding initial data..."
npx prisma db seed

echo "🚀 Starting the dev server..."
exec npm run dev
