#!/bin/sh
set -eu

node apps/backend/dist/scripts/migrate.js

# The builder bundles optional TypeScript overlays into the server artifact.
# The runtime image therefore needs neither source files nor a TS loader.
exec node apps/backend/dist/server.js
