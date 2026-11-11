# Policy Center

Scope: tenant rules that allow, block or require approval for a tool call. Their
approval proof is in [approvals](approvals.md#policy-center-approval-proof).

## Rules

- Tenant rules (`policy_rule`) are evaluated at the gateway before a managed or
  proxy tool runs, in ascending `priority` (ties by rule id). The first enabled
  rule that matches decides; with no match, the call is allowed
  (`services/policy/policy-engine.ts`). Example: an `allow` rule for a tool at
  priority 1 wins over a `block` rule for its category at priority 2.
- A rule is `condition -> effect`. Effects: `allow`, `require_approval`,
  `block`. Conditions:
  - `toolNames`;
  - `categories`: managed-tool domain or proxy server id;
  - `severities`: `read_only` or `file_change` (the legacy `command_execution`
    never matches);
  - `turnContexts`: `interactive` or `scheduled`.

  Conditions are AND; values in one condition are OR; an omitted or empty
  condition matches all.
- A proxy tool is `read_only` only when its upstream declares `readOnlyHint:
  true` (`deriveActionSeverity`, `services/mcp/policy-gate.ts`), so a severity
  rule trusts the upstream. For a proxy you do not trust, match on `toolNames`
  or `categories`.

## Enforcement and evidence

- `tenant_settings.policy_enforcement_mode`: `monitor` records matches only;
  `enforce` applies effects. The mode is in the turn's policy snapshot.
- Only matched rules write `policy_decision` evidence rows.
- Rule cache: `PolicyService` caches each tenant's rules for `ruleCacheTtlMs`. A
  rule change clears the cache on this replica, and with Redis on the others. If
  that message fails, the cache expires after the TTL. The enforcement mode is
  not cached: it comes from the turn's policy snapshot.

## Change rules safely

- Verify rules before you enforce them (`routes/admin/admin-policy-routes.ts`):
  `POST /admin/policy/simulate` (outcome for a sample action), `GET
  /admin/policy/lint` (rule problems), `GET /admin/policy/monitor-summary` (what
  monitor mode recorded), `GET /admin/policy/decisions` and
  `.../decisions/:decisionId` (evidence rows).
- A weaker rule change is a [sensitive
  change](sensitive-changes.md#weaker-controls-and-skill-releases).
- Overlay catalog categories: see [overlays](../overlays.md).

## Edit a rule

- Each rule has a `revision` (migration 086). It starts at 1. Each edit adds
  1, and a reorder adds 1 to each rule that it moves, because the place of a
  rule decides what it does.
- `PATCH /admin/policy/rules/:ruleId` must send `expectedRevision`: the
  revision that the change is based on. A partial patch, for example only
  `enabled`, sends it too. When the rule has another revision, the route
  answers 409 `policy_rule_conflict` and writes nothing: no change, no audit
  event, no owner notice and no rule cache drop. A deleted rule answers 404.
- `PolicyRuleStore.update` checks the revision under the tenant's rule lock,
  before it classifies the change, so a stale save never asks for step-up.
  The `UPDATE` also names the revision, so a writer without the lock cannot be
  overwritten. A create sends no revision.
- The rule editor (`components/admin/policy/admin-policy-rules-card.tsx`)
  keeps the saved rule that the draft started from and sends its revision.
  When a save gets 409, or the rule list shows a newer revision, the editor
  keeps the draft, shows the saved values next to it, and blocks Save until
  the admin chooses "Use the saved rule" or "Keep my changes". "Keep my
  changes" keeps the fields that the admin changed and takes the saved value
  of every other field. The next save sends the revision of the rule that the
  admin compared. A list refresh never moves the draft to a newer revision.
- When someone deleted the rule, the editor keeps the draft and can create
  it as a new rule.
