# Sandbox

Scope: the per-session E2B sandbox: backend, workspace, limits, template, and
the network policy. [Configuration](../configuration.md) owns the defaults of
the variables named here.

## E2B sandbox

- `deep-agents-e2b-backend.ts` (`E2bDeepAgentsSandbox`) implements deepagents
  `BaseSandbox` over the E2B SDK: `execute`, `uploadFiles`, `downloadFiles`, and
  workspace-relative `ls`, `read`, `grep`, `glob`.
- The workspace root is `/home/user/workspace/<sessionId>/`. `toSandboxPath`
  (`deep-agents-e2b-backend.ts`) maps `/`-rooted paths into it;
  `resolveInsideSandbox` (`services/runtime/sandbox-path.ts`) throws for a path
  that escapes it, and the file-tool overrides return that as a structured
  error. The check is lexical: it does not resolve symlinks. `delete` also
  guards against a symlinked path (`deep-agents-e2b-backend.ts`); other file
  tools rely on the E2B VM boundary.
- The sandbox is created at the first shell or workspace file call. In a normal
  chat it is kept across turns. In a project chat it ends with the runtime of
  its turn, and the next turn starts a new one ([session
  types](runtime.md#session-types)).
- Archive, delete and purge of a normal chat kill its saved sandbox. The session
  store reads `sessions.sandbox_id` under the session row lock and clears it in
  the transaction that changes the status. The status change also stops the
  execution lease, so after that transaction no runtime can adopt the sandbox.
  The kill (`services/runtime/e2b-sandbox-disposal.ts`) therefore needs no lease
  check. It sends no connect, and makes up to four tries inside
  `E2B_NETWORK_CONFIRM_TIMEOUT_MS`. A restored chat starts a new sandbox at its
  next shell or file call, with no `Workspace reset` notice.
- A security change of an account
  ([revocation](local-accounts.md#security-version-and-revocation)) kills the
  saved sandboxes of the account's chats. A process that an older turn started
  in the sandbox does not stop with the turn, so the turn stop alone is not
  enough. The transaction of the change locks the account's chats, stops the
  lease of each normal chat of the account (`stop_reason` `security_change`),
  takes each saved `sessions.sandbox_id` and clears it
  (`releaseAccountSandboxes` in `services/session-execution-store.ts`). After
  the commit, the process that made the change stops the account's runtimes in
  that process, then kills each taken sandbox with the same kill as archive.
  After the commit, an older turn on any replica cannot load, save or release a
  sandbox record, and it ends at its next lease check or heartbeat with the
  reason `security_change`. A turn that starts after the commit starts a new, empty
  sandbox, and the change does not kill it. The chat keeps its messages; the
  files of the old sandbox are lost, with no `Workspace reset` notice.
- The member removal and role routes lock the member's chats before the
  membership row, in the order that turn admission locks them. The other order
  can deadlock with a turn admission of that member.
- A project chat saves no sandbox, so the sandbox step of a security change takes
  none from it and leaves its lease. A chat that moved into a project keeps the id of the
  sandbox that it had as a normal chat. No project turn loads that id, so a
  security change of the chat's owner kills that sandbox.
- Idle teardown, runtime invalidation and shutdown do not kill a saved sandbox.
  This is on purpose: the next turn, on any replica, reconnects to it with its
  files.
- Known limits of the disposal kill (archive, delete, purge, security change):
  - A kill that fails after its tries, or a process that stops between the
    commit and the kill, leaves the sandbox with its files, its processes and its
    network until E2B expires it (`E2B_SANDBOX_TIMEOUT_MS` after the last turn
    start). The error log names the sandbox. Nothing tries the kill again,
    because the session row no longer names it, and no turn reconnects to it.
  - `auth:recover-owner` kills the sandboxes only when `E2B_API_KEY` is set in
    its environment. Otherwise its log names each sandbox that runs on.
  - The sandbox of a project chat is in the memory of the replica that runs the
    turn. After a security change, that replica kills it when the turn stops and
    the runtime is torn down: at once on the replica that made the change, and
    at idle teardown (`RUNTIME_IDLE_TIMEOUT_MS`) on the other replicas.
  - A turn that a request under the older security version admits while the
    change transaction runs can keep its lease. The tool context check refuses
    that turn at its first model call, before it can make a sandbox.
  - Tenant deletion kills no sandbox. Its receipt counts the saved sandbox ids
    ([resources outside the database](../operations.md#resources-outside-the-database)).
- Limits: `DEEP_AGENTS_EXECUTE_TIMEOUT_MS` per command, an output cap
  (`MAX_EXECUTE_OUTPUT_CHARS` in `deep-agents-e2b-backend.ts`), and
  `E2B_SANDBOX_TIMEOUT_MS`, a lifetime deadline that each turn start extends
  (activity inside a turn does not extend it).
- Backend memory: one backend serves all tenants, so it limits what it reads
  from a sandbox. A command sends at most `MAX_EXECUTE_OUTPUT_BYTES` of stdout
  and of stderr: `capCommandOutput` drops the rest in the sandbox, and the
  command runs to its end. A file read (file tools, `write_artifact`,
  `project_write_file`) stops at `ARTIFACT_MAX_UPLOAD_BYTES` and fails with
  `SandboxFileTooLargeError`.
- `execute` reports the exit code through the custom event
  `cogniplane.execute_result` (`execute-result-event.ts`). The stream mapper
  marks the tool card `failed` for a non-zero code. It never parses result text.
- Template: defined in `docker/template.ts`, built by `docker/build.ts` under
  the name `deep-agents-runtime-dev` with `make e2b-build`, selected with
  `E2B_TEMPLATE_ID`. It is the E2B base image plus a pinned Python data stack
  and command-line tools. It holds no agent code and no secrets. Its start
  command removes passwordless `sudo` and the empty root password.
- Change the template: edit the package lists in `docker/template.ts`, run `make
  e2b-build` with the same `E2B_API_KEY`, then start a new chat and run a shell
  command that uses the change. The rebuild keeps the template id, so
  `E2B_TEMPLATE_ID` stays the same; sandboxes created after the build use it.

## Sandbox network

Rules (`services/runtime/sandbox-network-policy.ts`; its header comment has the
details):

- A sandbox has no network unless the tenant approves hosts
  (`tenant_settings.approved_sandbox_egress_domains`, Admin > Agent behavior).
  E2B enforces the policy outside the guest.
- The network is fixed at creation. `Sandbox.create` gets a deny-all rule plus
  the approved hosts, and `Sandbox.getInfo` must confirm it before any command
  runs; a new sandbox that fails is killed. A check has
  `E2B_NETWORK_CONFIRM_TIMEOUT_MS` in total and `E2B_NETWORK_REQUEST_TIMEOUT_MS`
  per E2B request.
- At the first use in each turn or job, and at a reconnect, the backend compares
  an existing sandbox with the current policy (`deep-agents-e2b-backend.ts`):
  - match: the sandbox is used for the turn;
  - mismatch or gone: the backend kills it (only while the session lease is
    current) and creates a new one; its files are lost and the user sees a
    `Workspace reset` notice;
  - no report in time: the call fails and the sandbox stays, unused, with its
    files; the next call checks again.

  A list change applies at the next turn, not inside a running turn.
- No new command or file operation starts in a sandbox that the current turn did
  not confirm, or for a turn that ended, was cancelled, or was replaced. A
  command already running when the turn stops is not cancelled: it runs until it
  ends or reaches `DEEP_AGENTS_EXECUTE_TIMEOUT_MS`.
- Known limits: a kill that fails after all retries leaves the old sandbox
  running until E2B expires it, with its original network. The lease check
  before a kill is not atomic with the kill. The filter trusts the host name
  that a web request states. While any host is approved, all traffic to the
  guest resolver `8.8.8.8` is allowed, TLS included (DNS over HTTPS): data can
  leave through the names in DNS lookups (`sandbox-network-policy.ts`).

