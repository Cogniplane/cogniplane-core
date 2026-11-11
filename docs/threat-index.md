# Threat index

Scope: for security reviewers, each threat with its primary and second control.
The rules are in the [security model](security.md).

| Threat | Primary control | Second control |
|---|---|---|
| Cross-tenant data access | RLS with `withTenantScope` ([data](architecture/data.md#tenant-isolation)) | Explicit `tenant_id` predicates; restricted maintenance grants |
| Credential leak through the model | Model-blind tool context; gateway injects credentials ([tools](architecture/tools.md#mcp-gateway)) | `redactSecrets` on saved data; upstream secret scrubbing |
| Stolen access token | Short TTL; memory-only storage ([auth](architecture/auth.md#tokens-and-cookies)) | Step-up and owner notices for sensitive changes |
| Refresh token replay | Atomic `jti` rotation ([auth](architecture/auth.md#tokens-and-cookies)) | Family revocation on reuse |
| Account takeover after password change | Security version on tokens and tool contexts ([local accounts](architecture/local-accounts.md#security-version-and-revocation)) | Suspended connections and paused jobs; sandboxes of the account's chats killed |
| Forged MCP calls | Runtime token; trusted `_meta` context ([tools](architecture/tools.md#mcp-gateway)) | Proxy HMAC signature with nonce and body hash |
| Unapproved tool action | Interrupt before execution; single-use bound proof ([approvals](architecture/approvals.md)) | Policy Center enforce mode; approval TTL |
| Sandbox escape or exfiltration | E2B VM per session; default-deny network ([sandbox](architecture/sandbox.md)) | Workspace path guard; timeouts; no secrets in sandbox |
| Malicious upload or archive | Upload checks ([artifacts](architecture/projects-and-files.md#artifacts)) and archive checks ([skills](architecture/skills.md#import-and-lifecycle)) | Size limits; the backend runs `pdftotext` on PDFs with fixed arguments, a timeout and an output cap (`artifact-processor.ts`); PDF OCR runs `pdfinfo`, `pdftoppm` and `tesseract` with fixed arguments, a minimal environment, a page, time and output budget, and a concurrency limit (`services/pii/pdf-ocr.ts`) |
| PII sent to a model | Per-scope PII policy ([PII](architecture/pii.md)) | Weaker-policy step-up; audit of scans |
| Server-side request forgery | Public-host URL validation; DNS-pinned `ssrfSafeAgent` ([outbound requests](security.md#outbound-requests)) | Proxy MCP URLs limited to admin input |
| Malicious widget | Opaque-origin iframe, CSP, origin-checked messaging ([MCP Apps](architecture/mcp-apps.md#isolation)) | Admin-approved domains only |
| Admin access to member data | Owner and admin roles only; artifact downloads audited ([auth](architecture/auth.md#roles)) | Membership checks on every request |
| Runaway model cost | Monthly limit and per-turn reservation ([model spending](architecture/model-spending.md)) | Unknown usage blocks new turns |
