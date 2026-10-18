#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

echo "⏳ Starting Mostanad API Initialization..."

echo "🔄 Generating Prisma Client..."
npx prisma generate

if [ "$NODE_ENV" = "production" ]; then
  echo "🔄 Syncing database schema (migrate deploy)..."
  npx prisma migrate deploy

  echo "🌱 Seeding initial data..."
  npx prisma db seed

  echo "🚀 Starting Mostanad API server in PRODUCTION mode..."
  exec npm start
else
  # Never sync the schema with prisma's push command here: it drops every table/column the image's schema
  # lacks (a stale image wiped the dev DB twice). Migrations are additive-only.
  echo "🔄 Applying migrations (migrate deploy)..."
  npx prisma migrate deploy

  echo "🌱 Seeding initial data..."
  npx prisma db seed

  echo "🚀 Starting Mostanad API server in DEVELOPMENT mode..."
  exec npm run dev
fi
