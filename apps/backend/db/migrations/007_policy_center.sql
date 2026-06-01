-- Policy Center — runtime policy rule engine + decision evidence.
--
-- A `policy_rule` is a tenant-scoped, ordered condition→effect statement the
-- runtime evaluates for each proposed tool action. A `policy_decision` is the
-- replayable evidence row written when a rule matches. No-match/default-allow
-- actions deliberately do not write decision rows. Decisions are recorded even
-- in monitor mode (the `enforced` flag distinguishes a dry-run observation from
-- one that actually gated the action).
--
-- Conditions match on tool name, managed-tool category, read/write severity,
-- and whether the turn is interactive or scheduled. The condition set is stored
-- as JSONB so later dimensions can extend it without a schema change.
--
-- Outcomes: allow | require_approval | block.

-- ---------------------------------------------------------------------------
-- policy_rule
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.policy_rule (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_id text NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    description text,
    -- Lower priority numbers win; first match by ascending (priority, rule_id) decides.
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    effect text NOT NULL,
    -- { toolNames?: string[], categories?: string[], severities?: string[], turnContexts?: string[] }
    conditions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- Human-readable explanation surfaced to user + admin when this rule decides.
    reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT policy_rule_rule_id_unique UNIQUE (tenant_id, rule_id),
    CONSTRAINT policy_rule_effect_check CHECK (
        effect = ANY (ARRAY['allow'::text, 'require_approval'::text, 'block'::text])
    )
);

CREATE INDEX IF NOT EXISTS idx_policy_rule_tenant_eval
    ON public.policy_rule USING btree (tenant_id, enabled, priority, rule_id);

ALTER TABLE public.policy_rule ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'policy_rule'
          AND policyname = 'policy_rule_tenant_isolation'
    ) THEN
        CREATE POLICY policy_rule_tenant_isolation ON public.policy_rule
            USING ((tenant_id = current_setting('app.current_tenant_id'::text, true)))
            WITH CHECK ((tenant_id = current_setting('app.current_tenant_id'::text, true)));
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- policy_decision
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.policy_decision (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_id text NOT NULL,
    tenant_id text NOT NULL,
    session_id text,
    user_id text,
    runtime_id text,
    -- The evaluated action.
    tool_name text NOT NULL,
    tool_category text,
    severity text,
    server_id text,
    -- The matched rule (NULL when the default no-match path decided).
    matched_rule_id text,
    -- allow | require_approval | block
    outcome text NOT NULL,
    -- false in monitor mode (would-have decision); true when it gated the action.
    enforced boolean DEFAULT false NOT NULL,
    explanation text,
    -- Snapshot of the action context for replay (redacted before persistence).
    action_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT policy_decision_decision_id_unique UNIQUE (tenant_id, decision_id),
    CONSTRAINT policy_decision_outcome_check CHECK (
        outcome = ANY (ARRAY['allow'::text, 'require_approval'::text, 'block'::text])
    )
);

-- Default decisions browse: newest-first within a tenant, no filter. The (id DESC)
-- tail matches the query's tie-break (ORDER BY created_at DESC, id DESC) so the
-- planner can serve a filtered/paginated page straight from the index.
CREATE INDEX IF NOT EXISTS idx_policy_decision_tenant_created
    ON public.policy_decision USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_policy_decision_tenant_session
    ON public.policy_decision USING btree (tenant_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_policy_decision_tenant_outcome
    ON public.policy_decision USING btree (tenant_id, outcome, created_at);

ALTER TABLE public.policy_decision ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'policy_decision'
          AND policyname = 'policy_decision_tenant_isolation'
    ) THEN
        CREATE POLICY policy_decision_tenant_isolation ON public.policy_decision
            USING ((tenant_id = current_setting('app.current_tenant_id'::text, true)))
            WITH CHECK ((tenant_id = current_setting('app.current_tenant_id'::text, true)));
    END IF;
END
$$;
