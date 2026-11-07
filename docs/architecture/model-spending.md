# Model spending limits

Scope: the tenant monthly model-cost limit, per-turn reservations, the ledger,
and recovery. The limit is an estimate from the rates in
`services/token-cost-calculator.ts`, not a provider invoice cap.

## Policy

- A tenant has a monthly limit in USD (null: no limit; 0: no new turns) and a
  per-turn reservation. Admins set them in Admin > Usage. Changes apply to new
  turns only.
- A tenant with no stored policy gets `MODEL_SPENDING_MONTHLY_LIMIT_USD` and
  `MODEL_SPENDING_TURN_RESERVATION_USD` at its first read or admission. Later
  environment changes do not replace a stored policy.
- The month starts 00:00 UTC on day 1.

API (admins only; tenant and actor come from authentication; every change is
audited in its transaction):

| Route | Purpose |
|---|---|
| `GET /admin/model-spending` | Policy, current month charge, counts, unresolved reservations (paged, `nextCursor`) |
| `PUT /admin/model-spending` | `{ monthlyLimitUsd, turnReservationUsd, version }`; stale `version` returns 409 |
| `POST /admin/model-spending/:reservationId/close` | Stop an active reservation; keeps its charge, marks usage unknown |
| `POST /admin/model-spending/:reservationId/reconcile` | `{ actualUsd }` for an unknown reservation; a repeat returns 409 |

## Admission and accounting

- Interactive and scheduled turns use one admission path
  (`services/model-spending-store.ts`). Under a tenant database lock, admission
  compares settled charges plus open reservations with the limit, then reserves
  the full turn amount.
- Amounts are integer millionths of a USD, rounded up.
- The runtime records each model call before dispatch and its usage at the end
  (`deep-agents/model-spending-callback.ts`). Subagents, agent retries and
  summaries share the turn's reservation. With a reservation, provider SDK
  retries are off.
- A turn starts another call only while its known cost is below its reservation
  and no earlier call has missing usage. Calls in a turn run one at a time. A
  turn can exceed its reservation by one started call; there is no fixed USD
  bound on that call.
- A model that has no rate in the calculator cannot run when a limit is set; the
  refusal takes no allowance. Session titling:
  [models](models.md#utility-model).
- When the allowance runs out, model and tool dispatch stop and the turn ends
  with an error. It does not resume.
- Known usage releases the unused reservation at turn end.
- A failed or cancelled call settles the turn at its full reservation (or known
  cost if higher), and the turn starts no further call.
- A completed call with missing or invalid usage keeps the full reservation and
  blocks new turns for that month until an admin reconciles it. An event stream
  that shows more model starts than the ledger saw records an untracked call the
  same way.
- Turns without a limit create no reservations.
- Database failure at admission or call recording fails closed.

## Recovery

- A crash leaves its reservation charged; there is no automatic expiry.
- To resolve: find the session in the unresolved list; stop its turn (`POST
  /sessions/:sessionId/interrupt`); close the reservation; confirm in the
  provider's usage records that no request of that turn is still running; take
  the total from those records; then reconcile. Do not reconcile to zero only
  because usage is missing. Closing does not cancel a request already sent.

## Not covered

Sandbox, storage, external tools, PII processing, and calls that tools or
sandbox programs make with their own credentials are outside this ledger.
Message-based token analytics are separate and follow transcript retention.
