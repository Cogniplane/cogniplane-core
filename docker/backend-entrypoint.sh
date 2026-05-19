#!/bin/sh
set -eu

CODEX_CONFIG_DIR="${HOME}/.codex"
mkdir -p "${CODEX_CONFIG_DIR}"
WORKSPACE_ROOT="${RUNTIME_WORKSPACE_ROOT:-/tmp/cogniplane-core-runtime-workspaces}"

write_default_codex_config() {
  cat > "${CODEX_CONFIG_DIR}/config.toml" <<TOML
model = "${CODEX_MODEL:-gpt-5.4-mini}"
tool_output_token_limit = 25000

[features]
unified_exec = true
apply_patch_freeform = true
skills = true
shell_snapshot = true

[projects."${WORKSPACE_ROOT}"]
trust_level = "trusted"
TOML
}

if [ -n "${OPENAI_API_KEY:-}" ]; then
  rm -f "${CODEX_CONFIG_DIR}/auth.json" "${CODEX_CONFIG_DIR}/config.toml"
  write_default_codex_config
  printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null
  echo "Configured Codex with clean API-key auth state"
else
  if [ -f /codex-host/auth.json ]; then
    cp /codex-host/auth.json "${CODEX_CONFIG_DIR}/auth.json"
  fi

  if [ -f /codex-host/config.toml ]; then
    cp /codex-host/config.toml "${CODEX_CONFIG_DIR}/config.toml"
  else
    # Write a minimal config so codex works without a mounted config file.
    # RUNTIME_WORKSPACE_ROOT must be trusted so codex doesn't prompt interactively.
    write_default_codex_config
  fi
fi

pnpm db:migrate

# Run via tsx so optional TypeScript overlays can be loaded directly by the
# host process. The core OSS tree ships a no-op overlay module, while derived
# distributions can attach their own integrations without rebuilding first.
exec pnpm --filter @cogniplane/backend exec tsx src/server.ts
