FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Node 25 and later do not include Corepack.
RUN npm install -g corepack@0.36.0 && corepack enable

COPY package.json pnpm-lock.yaml tsconfig.base.json eslint.config.mjs ./
COPY docker/backend-pnpm-workspace.yaml pnpm-workspace.yaml
COPY apps/backend/package.json apps/backend/package.json
# shared-types' `prepare` script (which runs on `pnpm install`) calls
# `tsc -p tsconfig.json`, so the source must be present before install
# rather than copied after.
COPY packages/shared-types packages/shared-types
# Include the bundled SharePoint workspace packages.
COPY private private/

COPY patches patches

RUN pnpm install --frozen-lockfile

COPY apps/backend apps/backend
RUN pnpm --filter @cogniplane/backend build:bundle \
  && pnpm --filter @cogniplane/backend deploy --prod --no-optional --legacy /opt/backend

FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime

ARG BUILD_SHA=""
ARG BUILD_DATE=""

WORKDIR /app

ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_DATE=$BUILD_DATE
# The production startup checks (config.ts) apply only when NODE_ENV is set to a
# production value; an unset NODE_ENV counts as development. compose.yaml sets
# development for the local stack.
ENV NODE_ENV=production

# Project PDF previews invoke pdftotext at request time. PDF OCR for the PII
# scan (PII_PDF_OCR_ENABLED) uses pdfinfo, pdftoppm and tesseract.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/backend/node_modules apps/backend/node_modules
COPY --from=builder /opt/backend/package.json apps/backend/package.json
COPY --from=builder /workspace/apps/backend/bundle apps/backend/dist
COPY --from=builder /workspace/apps/backend/db apps/backend/db
COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh

# A new named volume copies this directory's owner, so appuser can write to it.
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/sh appuser \
  && install -d -o appuser -g appgroup /var/lib/cogniplane \
  && chmod +x /usr/local/bin/backend-entrypoint.sh

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["backend-entrypoint.sh"]
