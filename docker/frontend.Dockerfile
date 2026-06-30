FROM node:24-trixie-slim

# NEXT_PUBLIC_* values are baked into the client bundle by `next build`, so
# they MUST be set as ENV before the build step. Compose passes them as
# build args; nothing about them is secret.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_DEV_USER_ID=local-dev-user
ARG NEXT_PUBLIC_DEV_TENANT_ID=local-dev-tenant
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DEV_USER_ID=$NEXT_PUBLIC_DEV_USER_ID
ENV NEXT_PUBLIC_DEV_TENANT_ID=$NEXT_PUBLIC_DEV_TENANT_ID
# Acknowledge that this stack ships dev-headers auth in a production build.
# See next.config.ts for the rationale and the corresponding guard.
ENV COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD=1

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

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/bash appuser \
  && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# No wget install: Node 24 has fetch. 302→/login counts as healthy, hence <500.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@cogniplane/frontend", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
