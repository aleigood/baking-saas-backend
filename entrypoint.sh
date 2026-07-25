#!/bin/sh
set -e

echo "Running database migrations..."
attempt=1
max_attempts=30
until npx prisma migrate deploy; do
    if [ "$attempt" -ge "$max_attempts" ]; then
        echo "Database migrations failed after $max_attempts attempts."
        exit 1
    fi

    echo "Database is not ready or migration failed. Retrying in 2 seconds... ($attempt/$max_attempts)"
    attempt=$((attempt + 1))
    sleep 2
done

echo "Running database seed..."
node dist/prisma/seed.js

echo "Starting application..."
node dist/main
