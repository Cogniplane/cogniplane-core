-- Network policy of agent-run code in the sandbox (VULN-13).
--
-- tenant_settings.approved_sandbox_egress_domains: the hosts that the sandbox
-- of this tenant may reach. An empty list means no network access, which is
-- also the value that every existing tenant gets. The admin API checks each
-- entry, and the runtime checks it again before it reaches the provider.
--
-- sessions.sandbox_network_policy: {"sandboxId": "...", "hash": "..."}, the
-- network policy that was confirmed with the provider for the sandbox saved in
-- sessions.sandbox_id. It names the sandbox, so a replica that replaces
-- sandbox_id without writing this column (an older version during a rolling
-- deploy) leaves a record that no longer matches. The next reconnect then reads
-- the policy as unknown and applies it again. NULL means the same: sandboxes
-- saved before this column existed get the policy when they are next used.
--
-- RLS is tenant_id based, and migrate.ts reapplies the table GRANTs after every run.
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS approved_sandbox_egress_domains jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS sandbox_network_policy jsonb;
