import { Template } from 'e2b';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Version pins live in apps/backend/src/codex-release.json so the backend
// runtime diagnostics and the template build stay in sync. Bump them there.
const __dirname = dirname(fileURLToPath(import.meta.url));
const release = JSON.parse(
  readFileSync(
    resolve(__dirname, '../apps/backend/src/codex-release.json'),
    'utf8'
  )
) as { codexVersion: string; claudeAgentSdkVersion: string };

const CODEX_NPM_VERSION = release.codexVersion;
const CLAUDE_AGENT_SDK_NPM_VERSION = release.claudeAgentSdkVersion;
const UV_VERSION = '0.11.2';
const BUN_VERSION = '1.3.11';

// Core apt packages + GitHub CLI keyring. Run first so later steps can assume
// curl/gnupg/git/unzip/etc. are present.
const INSTALL_APT_BASE =
  'apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg ' +
  '&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg ' +
  '| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg ' +
  '&& chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg ' +
  '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" ' +
  '> /etc/apt/sources.list.d/github-cli.list ' +
  '&& apt-get update ' +
  '&& apt-get install -y --no-install-recommends bash git gh jq make python-is-python3 python3 python3-pip python3-venv ripgrep sqlite3 unzip wget ' +
  '&& rm -rf /var/lib/apt/lists/*';

// Node 24 from NodeSource — required for both the Codex CLI and the
// sandbox-agent harness (Claude Agent SDK ≥0.3.x spawns a CLI subprocess that
// needs a modern Node).
//
// CRITICAL: the e2b base image (e2bdev/base:latest) ships its OWN Node 20 at
// /usr/local/bin/node, and /usr/local/bin precedes /usr/bin on PATH. NodeSource
// installs Node 24 to /usr/bin/node, so without intervention the base image's
// Node 20 silently wins — both for `npm install -g` at build time AND for the
// harness at runtime. That left the Claude SDK's spawned subprocess running on
// Node 20, where it crashed immediately → "Query closed before response
// received" → Claude produced no output. So after installing Node 24 we shadow
// the base image's binaries at /usr/local/bin, making Node 24 the only Node any
// PATH lookup resolves. (`node -v` must print v24 for the build to proceed.)
const INSTALL_NODEJS =
  'curl -fsSL https://deb.nodesource.com/setup_24.x | bash - ' +
  '&& apt-get install -y nodejs ' +
  '&& rm -rf /var/lib/apt/lists/* ' +
  '&& ln -sf /usr/bin/node /usr/local/bin/node ' +
  '&& ln -sf /usr/bin/npm /usr/local/bin/npm ' +
  '&& ln -sf /usr/bin/npx /usr/local/bin/npx ' +
  '&& test "$(node -v | cut -d. -f1)" = "v24"';

// Python libs used by generated tools (pandas for data munging, jinja2 for
// templating). Pinned for reproducibility.
const INSTALL_PYTHON_PACKAGES =
  'pip3 install --no-cache-dir --break-system-packages pandas==2.2.3 jinja2==3.1.4';

// Codex CLI: backend spawns `codex app-server` inside the sandbox for the
// Codex runtime. Version is pinned in codex-release.json.
const INSTALL_CODEX_CLI = `npm install -g @openai/codex@${CODEX_NPM_VERSION}`;

// Claude Agent SDK: globally installed for the sandbox-agent harness. Version
// is pinned in codex-release.json.
//
// CRITICAL: the SDK does NOT bundle the `claude` CLI it spawns. The ~240 MB
// native binary ships as a per-platform OPTIONAL dependency
// (@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]) and the SDK resolves
// it at runtime via `require.resolve("<that package>/claude")`. `npm install -g`
// does not reliably pull optionalDependencies, so without an explicit install
// the binary is absent → the SDK falls back to an unspawnable embedded path →
// the spawned subprocess never starts → "Query closed before response received"
// (silent, exit 0, empty stderr) → Claude produces no output. The e2b base image
// is Debian (glibc), x64, so we install the linux-x64 (non-musl) binary package
// explicitly and assert it resolves at build time.
const CLAUDE_AGENT_SDK_BINARY_PKG = '@anthropic-ai/claude-agent-sdk-linux-x64';
const INSTALL_CLAUDE_AGENT_SDK =
  `npm install -g @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_NPM_VERSION} ` +
  `${CLAUDE_AGENT_SDK_BINARY_PKG}@${CLAUDE_AGENT_SDK_NPM_VERSION} ` +
  `&& test -x "$(npm root -g)/${CLAUDE_AGENT_SDK_BINARY_PKG}/claude"`;

// The harness loads the SDK with ESM `import("@anthropic-ai/claude-agent-sdk")`,
// and Node's ESM loader does NOT honor NODE_PATH (it only affects CommonJS
// `require()`). So we symlink the harness's adjacent node_modules straight at
// the real global install directory — that dir IS on the harness's ESM
// resolution path, so the bare import resolves.
//
// We resolve the global prefix dynamically via `npm root -g` so this never
// drifts regardless of which Node won on PATH (INSTALL_NODEJS now forces Node
// 24). Symlinking the whole node_modules (not just the @anthropic-ai scope)
// also makes the SDK's own sibling dependencies resolvable from /opt/cogniplane.
const LINK_CLAUDE_AGENT_SDK =
  'mkdir -p /opt/cogniplane ' +
  '&& ln -sfn "$(npm root -g)" /opt/cogniplane/node_modules ' +
  '&& test -d /opt/cogniplane/node_modules/@anthropic-ai/claude-agent-sdk';

// uv / uvx (Astral's fast Python package manager) — downloaded with sha256
// verification. Used by Python-based skill bundles.
const INSTALL_UV =
  `ARCH=$(uname -m) ` +
  `&& UV_ASSET="uv-\${ARCH}-unknown-linux-gnu.tar.gz" ` +
  `&& curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/\${UV_ASSET}" -o "/tmp/\${UV_ASSET}" ` +
  `&& curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/\${UV_ASSET}.sha256" -o "/tmp/\${UV_ASSET}.sha256" ` +
  `&& (cd /tmp && sha256sum -c "\${UV_ASSET}.sha256") ` +
  `&& tar -xz -f "/tmp/\${UV_ASSET}" -C /tmp ` +
  `&& mv /tmp/uv-\${ARCH}-unknown-linux-gnu/uv /usr/local/bin/uv ` +
  `&& mv /tmp/uv-\${ARCH}-unknown-linux-gnu/uvx /usr/local/bin/uvx ` +
  `&& rm -rf "/tmp/\${UV_ASSET}" "/tmp/\${UV_ASSET}.sha256" /tmp/uv-\${ARCH}-unknown-linux-gnu`;

// Bun (fast JS runtime) — sha256-verified download. Used by some tool
// invocations that prefer Bun over Node.
const INSTALL_BUN =
  'ARCH=$(uname -m) ' +
  '&& if [ "$ARCH" = "x86_64" ]; then BUN_ARCH="x64"; else BUN_ARCH="aarch64"; fi ' +
  `&& curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-\${BUN_ARCH}.zip" -o /tmp/bun.zip ` +
  `&& curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt ` +
  '&& EXPECTED=$(grep "bun-linux-${BUN_ARCH}.zip" /tmp/SHASUMS256.txt | awk \'{print $1}\') ' +
  '&& echo "${EXPECTED} /tmp/bun.zip" | sha256sum -c ' +
  '&& unzip -q /tmp/bun.zip -d /tmp/bun-install ' +
  '&& mv /tmp/bun-install/bun-linux-${BUN_ARCH}/bun /usr/local/bin/bun ' +
  '&& ln -s /usr/local/bin/bun /usr/local/bin/bunx ' +
  '&& rm -rf /tmp/bun.zip /tmp/SHASUMS256.txt /tmp/bun-install';

// Create the staging directory for the sandbox-agent harness (the `.copy`
// step below drops the harness script into this path).
const STAGE_SANDBOX_AGENT = 'mkdir -p /opt/cogniplane';

// Session workspaces are rooted at /home/user/workspace/<sessionId>/ — the
// backend uploads files there at turn start.
const PREPARE_USER_WORKSPACE = 'mkdir -p /home/user/workspace';

export const template = Template()
  .fromImage('e2bdev/base:latest')
  .setUser('root')
  .setWorkdir('/')
  // INSTALL_NODEJS forces Node 24 (NodeSource) to win on PATH by shadowing the
  // base image's Node 20 at /usr/local/bin. NodeSource's Debian package puts the
  // global prefix at /usr/lib/node_modules, so that's where `npm install -g`
  // lands. NODE_PATH only helps CommonJS require() — the ESM import in the
  // harness is handled by the /opt/cogniplane/node_modules symlink below — but
  // we set it correctly so require()-based lookups (e.g. the harness's
  // readSdkVersion) resolve instead of reporting "unknown".
  .setEnvs({
    NODE_PATH: '/usr/lib/node_modules'
  })
  .runCmd(INSTALL_APT_BASE)
  .runCmd(INSTALL_NODEJS)
  .runCmd(INSTALL_PYTHON_PACKAGES)
  .runCmd(INSTALL_CODEX_CLI)
  .runCmd(INSTALL_CLAUDE_AGENT_SDK)
  .runCmd(INSTALL_UV)
  .runCmd(INSTALL_BUN)
  .runCmd(STAGE_SANDBOX_AGENT)
  .runCmd(LINK_CLAUDE_AGENT_SDK)
  .copy('sandbox-agent/sandbox-agent.mjs', '/opt/cogniplane/sandbox-agent.mjs')
  .runCmd(PREPARE_USER_WORKSPACE)
  .setUser('user')
  .setWorkdir('/home/user');
