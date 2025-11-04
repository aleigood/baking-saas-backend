#!/bin/sh
set -e

# echo "Waiting for database to be ready..."
# sleep 10

# echo "Running database migrations..."
# npx prisma migrate deploy

# echo "Running database seed..."
# node dist/prisma/seed.js || { echo '[SEED] Seed script failed'; exit 1; }

echo "Starting application..."
node dist/main