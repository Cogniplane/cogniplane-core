import { Template } from 'e2b';

// Code-execution template for the Deep Agents runtime — the platform's sole
// E2B template since the Codex/Claude in-sandbox runtimes were retired.
//
// The Deep Agents provider runs the agent loop IN the Fastify backend — the
// sandbox is a dumb code-execution box, so this template deliberately omits
// agent CLIs and SDKs: just Python with the knowledge-worker data stack
// (pandas/openpyxl/matplotlib) on the stock e2b base image (which already
// ships Node).
//
// Built by `make e2b-build` under the name `deep-agents-runtime-dev`
// (building under the same name updates the template in place, preserving
// its id); the resulting template id is wired via E2B_TEMPLATE_ID.

const INSTALL_APT_BASE =
  'apt-get update && apt-get install -y --no-install-recommends ' +
  'bash ca-certificates curl git jq python-is-python3 python3 python3-pip python3-venv ripgrep sqlite3 unzip wget ' +
  '&& rm -rf /var/lib/apt/lists/*';

// Knowledge-worker data stack, pinned for reproducibility. openpyxl for
// Excel; matplotlib for chart generation.
const INSTALL_PYTHON_PACKAGES =
  'pip3 install --no-cache-dir --break-system-packages ' +
  'pandas==2.2.3 openpyxl==3.1.5 matplotlib==3.9.2 jinja2==3.1.4';

// Session workspaces are rooted at /home/user/workspace/<sessionId>/ — the
// backend uploads files there at turn start.
const PREPARE_USER_WORKSPACE = 'mkdir -p /home/user/workspace && chown user:user /home/user/workspace';

export const template = Template()
  .fromImage('e2bdev/base@sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f')
  .setUser('root')
  .setWorkdir('/')
  .runCmd(INSTALL_APT_BASE)
  .runCmd(INSTALL_PYTHON_PACKAGES)
  .runCmd(PREPARE_USER_WORKSPACE)
  .setUser('user')
  .setWorkdir('/home/user');
