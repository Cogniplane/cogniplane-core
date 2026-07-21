#!/bin/sh
set -eu

pnpm db:migrate

# Run via tsx so optional TypeScript overlays can be loaded directly by the
# host process. The core OSS tree ships a no-op overlay module, while derived
# distributions can attach their own integrations without rebuilding first.
exec pnpm --filter @cogniplane/backend exec tsx src/server.ts
