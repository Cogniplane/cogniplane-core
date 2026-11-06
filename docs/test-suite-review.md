# Test suite review

Reviewed on 2026-11-06 at base commit `206a3ee`.

## Assessment

The suite has useful breadth. Keep the security and runtime tests. The main
problems are uneven assertions, repeated setup, and repeated execution in CI.
There is no evidence that deleting a large share of the tests would improve
the balance between cost and defect detection.

Some tests check the same input at the same layer. Those can go. Other tests
look similar because they check different boundaries. A mocked store test,
an HTTP authentication test, and a Postgres RLS test make different claims.
One cannot replace the others.

## Scope and method

The repository has 689 test files and about 170,000 lines of tests:

| Area | Files |
| --- | ---: |
| Backend unit and local transport tests | 282 |
| Backend Postgres and Redis integration tests | 95 |
| Frontend source tests | 293 |
| SharePoint backend tests, including its database suite | 12 |
| Repository scripts | 6 |
| Separate sandbox Worker suite | 1 |

The runtime review inventoried 182 service suites plus the runtime-contract
suite, read 10 full files, and sampled 12 larger suites. The boundary review
inventoried 204 files, read 23 full suites and sections of 11 more, and
inspected 10 related implementation or support modules. The frontend review
inventoried 293 source suites and the Worker suite, and inspected 43 test
files with their related code. These scopes overlap at some boundaries.

The parent review checked discovery, all test and coverage configurations,
CI, the test runner, script tests, shared fakes, and the proposed edits.
Repository scans found no literal `test.only`, `it.only`, `describe.only`,
or unconditional `.skip` and `.todo` calls. Environment-dependent integration
skips do exist. Searches also found 69 single-line Promise-based timer waits;
this is a search count, not a claim that all 69 should change.

This is a suite-wide inventory and a risk-based manual review. It is not a
line-by-line review of every test. Runtime validation covers more files than
the manual inspection.

## Findings and changes

### Assertions must require useful output

- `services/turn-event-log.test.ts` checked mirrored output for absent secrets
  without requiring any mirrored output. It now waits for mirror delivery,
  compares its events with replay, and requires both redaction and safe text.
- `services/deep-agents/deep-agents-execute-outcome.test.ts` checked the failed
  result of duplicate parallel commands without requiring the successful
  result. Both parallel cases now require distinct IDs, both outputs, and
  reverse completion order. A result event releases the held command.
- `lib/async-queue.test.ts` had an assertion-free idempotent-close case and
  recorded consumed values without checking them. Closure checks now share
  one case, and delivery and buffered-error behavior have explicit assertions.

### Add missing security boundaries

- `lib/jwt.test.ts` now uses real JOSE signing and verification to reject
  malformed `amr`, `auth_time`, `sv`, and `fid` claims in access and refresh
  tokens. Valid claims are positive controls. Correct keys, algorithms, and
  audiences keep unrelated signature failures from satisfying these tests.
- `services/policy/policy-approval-proof.test.ts` now changes the tool name
  and server independently while keeping approved arguments unchanged.
  Argument-only tests did not protect all three action bindings.

### Remove duplication at the layer that owns it

- Removed six runtime approval examples already covered by the retained
  24-row matrix. That matrix still checks default, organization, automatic,
  and manual behavior.
- Removed one exact duplicate runtime-token path test.
- Removed the maximum-size table case from the full chat host. The component
  suite retains the large table and long-text checks. The catalog suite
  retains validation limits. Host tests retain binding, theme, panel placement,
  hostile inputs, and a representative validation failure for each component.
- The conditional route census now captures its common enabled baseline
  once. It still builds each of the six tested configurations and checks
  their exact registered routes. This removes five identical app builds.

### Make time and test isolation explicit

- `services/mail/mail-outbox-worker.test.ts` now waits until the pre-send
  query starts before stopping the worker. A 20 ms sleep did not identify
  that phase.
- `lib/uuid.test.ts` replaces 5,000 uncontrolled calls with a fixed clock,
  a short same-millisecond sequence, and backward and forward clock cases.
  Each case starts with fresh module state.
- The SDK retry demonstration in `services/runtime/e2b-sandbox.test.ts`
  stops after the second real HTTP request. The assertion only needs proof
  of a retry, so waiting for every later backoff adds no evidence. The test
  retains the real installed SDK, local server, failure deadline, and abort
  cleanup.
- `use-admin-person-data.test.tsx` and `use-enabled-settings-sections.test.tsx`
  now unmount hooks and clear QueryClients before restoring test state.
  Vitest disables globals, so RTL cannot register its automatic cleanup here.
- Person-email polling now covers `queued` and `sending` transitions to
  terminal states and checks that another person's queued email does not
  start polling. Fake timers replace elapsed-time polling.
- Removed an obsolete 180 ms focus wait from the model availability card.
  The production blur handler is synchronous.
- The initial full run failed once while the view suite waited for an old
  transcript message. Its helper now waits for the side-panel title, which is
  the state those tests exercise. The original suite passed in a focused
  rerun, so the initial failure is not evidence of a product defect.

### Observe database races and release locks after failure

- `integration/skill-revision-cleanup.integration.test.ts` now observes the
  delete blocked behind its own activation transaction through PostgreSQL.
  A 300 ms delay only established that the promise had not settled.
- `integration/policy-rule-concurrency.integration.test.ts` now counts
  waiters for its holder's advisory lock. Unrelated advisory waiters cannot
  satisfy the condition.
- Both suites roll back before releasing a holder and await pending work.
  A rollback failure discards the connection. An assertion failure can no
  longer return an open transaction to the pool through these paths.

### Stop repeating the main suites in PR CI

The test job used to run the workspace suite, backend and frontend full-source
coverage, and both imported-module coverage passes. Each main unit suite ran
three times in that job. It now runs each main suite once with full-source
coverage, plus the remaining workspace projects. Negative project filters
exclude only the two covered projects and the separately run integration
project, so future workspace projects remain eligible.

Coverage exclusions and the backend floor are unchanged. The frontend floor
now records the measured suite rather than its obsolete September baseline.
Imported-module commands remain available manually. Their denominators change
with imports, so their advisory trend does not justify another full execution
on every PR. The separate
integration job still owns real Postgres and Redis checks. Its advisory merged
coverage step still repeats backend coverage and integration tests. Reusing
reports across jobs is a separate CI improvement.

## Tests to keep

- RLS catalog checks inspect schema policies and the actual application role.
  RLS write-path checks verify visibility through production writers.
- Database scope checks verify connection reuse, including the same backend
  PID. Unit SQL expectations cannot prove pooled connection isolation.
- Approval consumption races observe blocked database updates before release
  and then require single consumption.
- Step-up route census tests and per-route authorization cases cover route
  inventory and runtime behavior separately.
- Real graph and browser-agent tests check event conversion, saved results,
  reload behavior, stream loss, draft retention, and approval controls.
- Real hashing, tampering, and SDK wire tests protect contracts that mocks
  would bypass. Keep them even when a mocked equivalent would run faster.

## Remaining priorities

1. Add a small real-browser suite for hit testing, overflow, viewport changes,
   and keyboard focus. jsdom layout stubs cannot prove these behaviors. The
   local smoke script checks backend HTTP and SSE, not browser interaction.
2. Consider strict unexpected-request accounting in the frontend fixture
   server. Its fallback returns 404; application error handling can consume
   that response without failing a test. Establish expected background
   requests before enforcing this across existing suites.
3. Replace remaining fixed waits where an event or persisted state can prove
   completion. Some 400 ms waits cover real preview and persistence delays.
   Removing them without a replacement would weaken the tests.
4. Profile CI after removing repeated executions. Keep file isolation unless
   measured savings justify explicit ownership of shared mocks, globals,
   timers, and module state. Do not parallelize the shared-database project
   until its cross-test fixture assumptions change.
5. Use full-source coverage to locate gaps, then inspect their risk.
   Imported coverage alone hides modules that no test loads. Raising a
   percentage without checking user behavior would not resolve that gap.

The design issue is uneven ownership of boundary matrices and assertions.
Keep exhaustive input rules near their owner, and keep a smaller set of
cross-layer tests that proves wiring and security. Test count is a poor target.

## Validation record

The initial root run discovered 688 Vitest files and 10,301 cases. It passed
9,334 cases, failed one frontend readiness case, and skipped 966 cases without
database configuration. The Worker uses a separate Node test command.

The initial run took 205 seconds on this development machine. Other workloads
were active, so it is not a stable CI benchmark. A focused before-and-after
run measured the SDK retry case at 554 ms and 91 ms. Those single measurements
do not establish a whole-suite speedup. The CI change removes known repeated
executions; its elapsed-time effect needs a new CI run.

The final full-source coverage run passed all 282 backend unit suites and
all 293 frontend suites. Backend coverage measured 83.53% lines, 75.86%
branches, and 82.42% functions. Frontend coverage measured 93.25% lines,
88.10% branches, and 87.68% functions. The old frontend gates were 29%, 24%,
and 19%, far below the existing tests. The new gates are 92%, 87%, and 86%,
using the backend's rule of leaving at least one percentage point of margin.
No coverage exclusions were added to obtain these figures.

Final coverage, database, lint, typecheck, and PR review results are recorded
in the PR description. No live model-provider or E2B service call was made.
