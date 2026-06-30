-- 007_policy_center.sql enables row-level security but does not FORCE it, so
-- table owners could bypass tenant isolation. Apply the owner enforcement
-- here — fresh and existing databases both pick it up, and the applied 007
-- migration stays immutable.
ALTER TABLE public.policy_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE public.policy_decision FORCE ROW LEVEL SECURITY;
