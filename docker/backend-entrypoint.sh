#!/bin/sh
set -eu

# Migrations run in the separate migrate service before this process starts.
# Clear bootstrap-only settings inherited from a deployment env file.
unset MIGRATION_DATABASE_URL POSTGRES_PASSWORD APP_USER_PASSWORD MAINTENANCE_USER_PASSWORD

# The builder bundles optional TypeScript overlays into the server artifact.
# The runtime image therefore needs neither source files nor a TS loader.
exec node apps/backend/dist/server.js
