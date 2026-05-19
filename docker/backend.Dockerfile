FROM node:24-trixie-slim

ARG CODEX_NPM_VERSION=0.130.0
ARG UV_VERSION=0.11.2
ARG BUN_VERSION=1.3.11
ARG BUILD_SHA=""
ARG BUILD_DATE=""

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_DATE=$BUILD_DATE

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    git \
    gh \
    jq \
    make \
    python-is-python3 \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    sqlite3 \
    unzip \
    wget \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g @openai/codex@${CODEX_NPM_VERSION}

# uv — fast Python package/project manager (pinned, checksum-verified)
RUN ARCH=$(uname -m) \
  && UV_ASSET="uv-${ARCH}-unknown-linux-gnu.tar.gz" \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}" -o "/tmp/${UV_ASSET}" \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}.sha256" -o "/tmp/${UV_ASSET}.sha256" \
  && (cd /tmp && sha256sum -c "${UV_ASSET}.sha256") \
  && tar -xz -f "/tmp/${UV_ASSET}" -C /tmp \
  && mv /tmp/uv-${ARCH}-unknown-linux-gnu/uv /usr/local/bin/uv \
  && mv /tmp/uv-${ARCH}-unknown-linux-gnu/uvx /usr/local/bin/uvx \
  && rm -rf "/tmp/${UV_ASSET}" "/tmp/${UV_ASSET}.sha256" /tmp/uv-${ARCH}-unknown-linux-gnu

# bun — fast JS/TS runtime and package manager (pinned, checksum-verified)
RUN ARCH=$(uname -m) \
  && if [ "$ARCH" = "x86_64" ]; then BUN_ARCH="x64"; else BUN_ARCH="aarch64"; fi \
  && BUN_ZIP="bun-linux-${BUN_ARCH}.zip" \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ZIP}" -o "/tmp/${BUN_ZIP}" \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt \
  && (cd /tmp && grep "${BUN_ZIP}" SHASUMS256.txt | sha256sum -c) \
  && unzip -q "/tmp/${BUN_ZIP}" -d /tmp/bun-install \
  && mv /tmp/bun-install/bun-linux-${BUN_ARCH}/bun /usr/local/bin/bun \
  && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf "/tmp/${BUN_ZIP}" /tmp/SHASUMS256.txt /tmp/bun-install

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
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
COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh

RUN pnpm build
RUN chmod +x /usr/local/bin/backend-entrypoint.sh

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /bin/bash appuser \
  && mkdir -p /home/appuser/.codex /home/appuser/bin /runtime-workspaces \
  && chown -R appuser:appgroup /home/appuser /runtime-workspaces

ENV PATH=/home/appuser/bin:/home/appuser/.local/bin:$PATH

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["backend-entrypoint.sh"]
