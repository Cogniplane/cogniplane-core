FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS builder

# OpenNext starts workerd during builds, which reads the system CA store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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

COPY patches patches

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @cogniplane/frontend build

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Next's traced output contains only the server and its runtime dependencies.
# Static assets and public files are served by the standalone server too.
COPY --from=builder /app/apps/frontend/.next/standalone ./
COPY --from=builder /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder /app/apps/frontend/public ./apps/frontend/public

# The official Node image already provides an unprivileged uid 1000 user.
# Build artifacts are world-readable, so no recursive ownership pass is needed.
USER node

EXPOSE 3000

# No wget install: Node 24 has fetch. 302→/login counts as healthy, hence <500.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/frontend/server.js"]
