-- A failed call ended with a provider error, a cancellation, or the end of its
-- turn. Its partial usage is not reported, so settlement keeps at least the
-- full turn reservation. Unlike 'unknown', it does not block new admission.
ALTER TABLE model_spending_calls DROP CONSTRAINT model_spending_calls_status_check;
ALTER TABLE model_spending_calls ADD CONSTRAINT model_spending_calls_status_check
  CHECK (status IN ('pending', 'complete', 'unknown', 'failed'));
