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

// Guest privilege hardening (VULN-11). Commands from the agent run as `user`
// (the template's default user; the backend never passes `user: 'root'`). The
// stock e2bdev/base image gives that account passwordless root two ways, both
// seen in a built template: `NOPASSWD: ALL` sudo (a line in /etc/sudoers, plus
// the `sudo` group and its `%sudo` rule), and an empty root password, so a
// plain `su` reaches root too. The application needs neither. E2B's own
// services (envd, chrony, sshd) run as root under systemd and use neither.
//
// The grant cannot be removed in a normal build step: E2B re-adds `user` to
// the sudo group and re-appends the sudoers line while it finalizes the
// template, after every build step (journal: `usermod: add 'user' to group
// 'sudo'` right after the finalize boot). The start command is the first
// thing that runs after that, so the removal lives there. It runs as `user`,
// uses the grant one last time, and leaves root as the only sudoer, takes
// `user` out of the sudo group and locks the root password. The ready command
// is the gate: the build cannot finish while `user` can still reach root.
//
// This is guest hardening only. It does not limit the network and it does not
// replace provider isolation. Network egress is enforced by E2B when the
// backend creates the sandbox (services/runtime/sandbox-network-policy.ts).
const GUEST_HARDENING_SCRIPT = [
  'set -eu',
  "printf '%s\\n' 'Defaults env_reset' " +
    "'Defaults secure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"' " +
    "'Defaults use_pty' 'root ALL=(ALL:ALL) ALL' > /etc/sudoers",
  'chown root:root /etc/sudoers',
  'chmod 0440 /etc/sudoers',
  'visudo -cf /etc/sudoers',
  'gpasswd -d user sudo || true',
  'passwd -l root'
].join('\n');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// `|| true`: if E2B stops granting sudo, there is nothing to remove and the
// ready command below still decides whether the build may finish.
const START_CMD = `sudo -n sh -c ${shellQuote(GUEST_HARDENING_SCRIPT)} || true`;

const READY_CMD = [
  "if sudo -n true >/dev/null 2>&1; then exit 1; fi",
  "if sh -c 'echo | su root -c true' >/dev/null 2>&1; then exit 1; fi",
  "if id -nG | grep -qw sudo; then exit 1; fi"
].join('; ');

export const template = Template()
  .fromImage('e2bdev/base@sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f')
  .setUser('root')
  .setWorkdir('/')
  .runCmd(INSTALL_APT_BASE)
  .runCmd(INSTALL_PYTHON_PACKAGES)
  .runCmd(PREPARE_USER_WORKSPACE)
  .setUser('user')
  .setWorkdir('/home/user')
  .setStartCmd(START_CMD, READY_CMD);
