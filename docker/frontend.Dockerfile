FROM node:24.11.1-trixie-slim@sha256:4623e8ac1eb5f35b0a91b85424283c1b97a416a77375dfa6a2e9bfb0b2c351c9

# NEXT_PUBLIC_* values are baked into the client bundle by `next build`, so
# they MUST be set as ENV before the build step. Compose passes them as
# build args; nothing about them is secret.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_DEV_USER_ID=""
ARG NEXT_PUBLIC_DEV_TENANT_ID=""
ARG NEXT_PUBLIC_DEV_AUTH_KEY=""
ARG COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DEV_USER_ID=$NEXT_PUBLIC_DEV_USER_ID
ENV NEXT_PUBLIC_DEV_TENANT_ID=$NEXT_PUBLIC_DEV_TENANT_ID
ENV NEXT_PUBLIC_DEV_AUTH_KEY=$NEXT_PUBLIC_DEV_AUTH_KEY
ENV COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD=$COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN corepack enable

# Copy the entire workspace before install so the shared-types `prepare`
# script (which runs `tsc -p tsconfig.json`) can find its source files.
# We could --ignore-scripts and build manually, but copying everything is
# simpler and the install layer is rebuilt anyway when source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps/frontend apps/frontend
COPY packages/shared-types packages/shared-types
# Private overlays may or may not exist in the build context. On the private
# tree they're real workspace packages; on the public mirror they're stubbed
# out via the rewrite of apps/frontend/src/overlays.ts. The Dockerfile must
# work on both. The bracket-pattern matches "private" if it exists and
# silently no-ops if not. The destination is named verbatim so the image
# layout matches the workspace.
COPY privat[e] private/

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @cogniplane/frontend build

# The official Node image already provides an unprivileged uid 1000 user.
# Build artifacts are world-readable, so no recursive ownership pass is needed.
USER node

EXPOSE 3000

# No wget install: Node 24 has fetch. 302→/login counts as healthy, hence <500.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/frontend/node_modules/next/dist/bin/next", "start", "apps/frontend", "--hostname", "0.0.0.0", "--port", "3000"]
