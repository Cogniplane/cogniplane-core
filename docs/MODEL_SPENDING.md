# Tenant model spending

Tenants can set a monthly estimated model-cost limit in USD and a per-turn
reservation. Interactive messages and scheduled jobs use the same admission
path. The limit is an estimate based on the rates in
[token-cost-calculator.ts](../apps/backend/src/services/token-cost-calculator.ts).
It is not a provider invoice cap.

## Configure a tenant

Open **Admin > Usage** to see the current UTC month's model budget. The panel
shows the amount charged or held, the monthly limit, the next turn's hold, and
the room remaining. The Overview work queue warns at 80% and links to the
budget when new turns are blocked. Token reports have their own period selector;
it does not change the budget month.

Select **Change budget**, or **Set a limit** for an unlimited tenant. Choose a
monthly limit, no limit, or a pause on new turns. Changes apply to new turns;
existing reservations keep their allowances. If another administrator changes
the policy, the dialog keeps your draft. Load the current budget, compare the
values, then save again.

**Advanced: unresolved reservations** lists active reservations and unknown
usage, including earlier months. Open a session before you close or reconcile
its reservation. Earlier-month records do not block this month's admissions.
Reconciliation starts with an empty amount and asks you to confirm that provider
requests have ended and that you verified the total cost.

An authenticated tenant administrator can use these backend endpoints. All
requests use the tenant and actor from authentication.

- `GET /admin/model-spending` returns the policy, current month charged USD,
  active and unknown reservation counts, and up to 200 unresolved reservations,
  ordered by reservation ID. Unresolved entries include older months. Pass the
  returned `nextCursor` as `?cursor=...` to read the next page until it is null.
  Counts and charged USD always cover the whole current month.
- `PUT /admin/model-spending` accepts
  `{"monthlyLimitUsd":100,"turnReservationUsd":1,"version":1}`.
  Send the version from GET. A concurrent update returns 409. A monthly limit
  of zero denies new turns. A null limit permits unlimited new turns.
- `POST /admin/model-spending/:reservationId/close` closes an active
  reservation for investigation. It retains its charge, marks usage unknown,
  and prevents further model calls under that reservation.
- `POST /admin/model-spending/:reservationId/reconcile` accepts
  `{"actualUsd":0.25}` for an unknown reservation. It replaces the charge with
  the administrator's verified total and records an audit event. Repeating the
  request returns 409.

Policy updates, closes, and reconciliation are audited in the same transaction
as the change. Members cannot use these endpoints.

For a tenant without a stored policy, the backend uses
`MODEL_SPENDING_MONTHLY_LIMIT_USD` and
`MODEL_SPENDING_TURN_RESERVATION_USD` from
[configuration](CONFIGURATION.md). The first read or admission stores that
policy. Later environment changes do not replace stored policies. Existing
tenants have no limit until configured if the monthly default is unset.

## Admission and accounting

The ledger uses integer millionths of a USD and rounds each call's estimate up.
The ledger stores policy and reconciliation amounts with up to six decimal
places exactly. It rounds an amount with more decimal places up to the next
millionth.
The accounting month starts at 00:00 UTC on the first day. Under a tenant-level
database lock, admission checks settled charges plus outstanding reservations,
then reserves the full turn amount. Different backend replicas share that lock.

The runtime records each model call before dispatch and records its usage when
the call ends. Subagents, retries at the agent level, and conversation summaries
share the turn allowance. For a turn with a reservation, provider SDK retries
are disabled because failed attempts do not reliably report separate usage.
Turns without a limit keep the provider SDK's default retries.

Models without an entry in the cost calculator cannot run when a limit is
enabled. Admission refuses such a model before it reserves the turn, so the
refusal takes no allowance and does not block other turns. For these tenants,
automatic session titling uses only the operator-run local titler
(`UTILITY_LLM_*`). The paid provider fallback is skipped.

A model call refused before dispatch adds no charge and no unknown usage. If
the event stream reports more model starts than the spending callback saw, a
model ran outside the ledger. The turn then records an untracked call, and its
usage is unknown until an administrator reconciles it.

A turn may start another call only while its known cost is below its reservation
and no earlier call has missing usage. Model calls within a turn are serialized.
An admitted turn can exceed its reservation by the cost of one already-started
model invocation. Concurrent admitted turns can each have such an overrun.
There is no fixed USD bound on that invocation. Provider context limits, output
limits and prices differ; provider invoices can differ from these estimates.

On exhaustion, further model and tool dispatch stops. The existing transcript,
artifacts and checkpoints remain subject to their normal persistence and retention
rules. The turn ends with an error explaining the allowance. It does not
automatically resume or obtain a larger reservation. An administrator can adjust
the policy and the user can start a new turn. Policy changes apply to new
admissions; they do not resize existing reservations.

Known usage returns the unused part of the reservation at turn completion.

Turns admitted with no limit do not create reservations in this ledger. Existing
reservations remain when an administrator removes the limit. Unknown records
do not block unlimited admissions, but current-month unknown records block new
turns if a limit is set again.

A call that ends with a provider error, a cancellation, or the end of its turn
is recorded as failed. Its partial usage is not reported, so the turn is
settled at its full reservation, or at its known costs if they are higher. No
further model call starts in that turn. A failed call does not block new turns.

A call that completes but reports missing or invalid usage indicates an SDK or
provider contract change. It retains the full reservation in addition to known
costs. New turns in that month are blocked until the unknown record is
reconciled. A turn crossing a month boundary cannot start another model call
using the old month's reservation. Calls already in flight settle to the month
in which the turn was admitted.

Deleting a session or message does not delete its spending records. Tenant
deletion removes them with the tenant. The ledger is separate from the existing
message-based token analytics, which can lose rows through transcript retention.

## Failure recovery

A process crash leaves its reservation charged. Reservations have no automatic
expiry or refund. Inspect the unresolved list to identify the session and turn.
Stop the affected work, close the reservation if it remains active, and confirm
that in-flight provider requests have ended before reconciliation. Closing a
reservation does not cancel a request already sent to a provider.

Use provider records and recorded call usage to establish the complete cost.
Do not reconcile to zero merely because a response or usage record is missing.
Late call completions do not overwrite an administrator's reconciliation.
If the database is unavailable at admission or call recording, new model work
fails closed. If settlement fails, the original reservation remains charged
until recovery.

## Costs outside this limit

Sandbox execution, storage, external tool services and PII processing are outside
this model allowance. This ledger does not estimate them or treat them as zero.
PII analytics and available provider or sandbox billing remain separate sources.
It also does not control calls made directly by an external tool or sandbox
program using credentials supplied outside the agent model path.
