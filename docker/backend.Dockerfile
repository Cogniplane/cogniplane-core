FROM node:24.11.1-trixie-slim@sha256:4623e8ac1eb5f35b0a91b85424283c1b97a416a77375dfa6a2e9bfb0b2c351c9 AS builder

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.base.json eslint.config.mjs ./
COPY docker/backend-pnpm-workspace.yaml pnpm-workspace.yaml
COPY apps/backend/package.json apps/backend/package.json
# shared-types' `prepare` script (which runs on `pnpm install`) calls
# `tsc -p tsconfig.json`, so the source must be present before install
# rather than copied after.
COPY packages/shared-types packages/shared-types
# Private overlay packages may or may not exist in the build context. On
# the private tree they're real workspace packages; on the public mirror
# they're stubbed out via the rewrite of apps/backend/src/overlays.ts.
# The bracket-pattern silently no-ops on the public tree.
COPY privat[e] private/

RUN pnpm install --frozen-lockfile

COPY apps/backend apps/backend
RUN pnpm --filter @cogniplane/backend build:bundle \
  && pnpm --filter @cogniplane/backend deploy --prod --no-optional --legacy /opt/backend

FROM node:24.11.1-trixie-slim@sha256:4623e8ac1eb5f35b0a91b85424283c1b97a416a77375dfa6a2e9bfb0b2c351c9 AS runtime

ARG BUILD_SHA=""
ARG BUILD_DATE=""

WORKDIR /app

ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_DATE=$BUILD_DATE

COPY --from=builder /opt/backend/node_modules apps/backend/node_modules
COPY --from=builder /opt/backend/package.json apps/backend/package.json
COPY --from=builder /workspace/apps/backend/bundle apps/backend/dist
COPY --from=builder /workspace/apps/backend/db apps/backend/db
COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/sh appuser \
  && chmod +x /usr/local/bin/backend-entrypoint.sh

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["backend-entrypoint.sh"]
