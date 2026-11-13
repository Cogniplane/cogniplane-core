# PII protection

Scope: personal-data detection for chat prompts, uploads and imports: provider,
modes, scopes, and the sync and async scan paths. Weakening a policy is a
[sensitive change](sensitive-changes.md#weaker-controls-and-skill-releases).

`services/pii/`. Detection is opt-in per tenant (Admin > Privacy). The same page
shows provider status, scan metrics, queue state and the breaker timeline (`GET
/admin/pii/*`, `routes/admin/admin-pii-routes.ts`).

## Detection and modes

- Provider: any OpenAI-compatible `/chat/completions` endpoint, or Ollama
  `/api/chat` (`PII_LLM_WIRE_FORMAT`), configured by `PII_PROVIDER_ENABLED` and
  `PII_LLM_*`. The operator chooses the vendor and accepts its data handling.
  `PII_PROVIDER_TIMEOUT_MS` bounds one provider call. The circuit breaker
  (`PII_BREAKER_*`) opens after repeated failures; with `REDIS_URL`, replicas
  share its state.
- A rule-based detector always runs; provider findings are merged with it.
  Its rules run on the event loop in linear time; `PII_ARTIFACT_MAX_BYTES`
  bounds the text of one file scan, so a higher limit blocks the backend for
  longer. A new rule needs a large-input case in the child-process test of
  `rule-based-pii-detector.test.ts`.
- Modes (`services/pii/pii-protection-service.ts`):

| Mode | Chat prompts | Files (uploads, imports) |
|---|---|---|
| `detect` | Report findings. No provider: rules only. Provider circuit breaker open: rules only. Other provider errors: the check fails | Same as for prompts |
| `transform` | The provider replaces values before the model sees the text. No provider or a provider error: the check fails | Report only; the file is not changed |
| `block` | Refuse on findings. No provider or a provider error: the check fails | Refuse on findings. No provider: rules only. A provider error: the scan fails |

## Findings and scopes

- Stored findings follow `rawRetention`: `never` (default) clears the matched
  values; `admin_only` keeps them in plain text for admins;
  `reversible_encrypted` encrypts them with `PII_RETENTION_KEK` (without the
  key, a scan in this mode fails with `pii_kek_missing`). No route decrypts
  them. Keeping more raw values is a [weaker
  change](sensitive-changes.md#weaker-controls-and-skill-releases).
- CSV files: rules scan the whole file; the provider gets only a preview (the
  header and the first rows, bounded by `PII_CSV_PREVIEW_ROWS` and
  `PII_CSV_PREVIEW_MAX_BYTES`, in UTF-8 bytes; `buildCsvPreview`).
- Scopes: chat prompts, uploads, and import sources that overlays register. The
  skill-improvement corpus (`skill_corpus`) is always in scope while protection
  is on, whatever the chat scope says; a transform replaces the corpus text and
  a block stops the tool.

## Scan paths

- Sync path: `services/pii/chat-prompt-pii.ts` calls
  `PiiProtectionService.evaluateTextWithPolicy` for chat prompts before the
  runtime sees them. A block saves a system message ("Message blocked by
  organization policy.") and answers with a normal SSE reply
  (`respondWithPiiBlock`, `routes/messages.ts`). A provider error answers 422
  when it is permanent, 503 otherwise.
- Files (`pii-artifact-scan-enqueuer.ts`): in `block` mode, and for a content
  type the scan cannot read in any mode, the upload is scanned or rejected at
  once (`runSyncBlock`). In `detect` and `transform` modes a readable file is
  queued (`runAsync`).
- Agent project drafts (`project_write_file`, `project_reconcile_conflict`):
  `ProjectFileStore.createAgentDraftFromContent` scans the bytes at once with
  the uploads scope and mode, before it stores them. A block refuses the draft
  (422 `pii_block`). A store without the PII service refuses every draft (503
  `pii_protection_unavailable`). `app-dependencies.ts` gives the service to the
  app's store; the project file routes and tools use that store.
- Async path: `pii_scan_runs` and `pii_scan_jobs` scan stored content,
  `PII_SCAN_MAX_CONCURRENT_JOBS` per worker tick. A file larger than
  `PII_ARTIFACT_MAX_BYTES` fails with `file_too_large` and is not retried.
  Scannable text: plain and structured text, shell scripts, and PDF text through
  `pdftotext` (`scannable-text.ts`). With the uploads scope on, images and
  Office files are rejected (`unsupported_mime`). For PDF images, see [PDF
  OCR](#pdf-ocr).
- A queued scan applies the policy current when it runs and records the mode and
  settings revision it read. It records its decision on the scan run
  (`pending_decision`, migration `084`) before it acts; a retry finishes that
  decision and does not evaluate again.

## PDF OCR

`PII_PDF_OCR_ENABLED` is off by default. When it is off, the scan reads only the
PDF text, a PDF without text is rejected (`pdf_extraction_failed`), and each PDF
verdict stores `imagesNotScanned: true` (UI: "(text only)").

When it is on, the PII scan of an uploaded or imported PDF also runs OCR
(`services/pii/pdf-ocr.ts`). Project drafts do not get OCR yet, because their
image coverage is not stored.

- Location: the backend host. `pdfinfo` reads the page count, `pdftoppm` renders
  one page at a time (300 DPI, grayscale, longest side 3508 px), and `tesseract`
  reads it (`PII_PDF_OCR_LANGUAGES`). No content goes to an additional service.
  The OCR text goes to the same rules and PII provider as the PDF text.
- Processes: fixed argv, no shell, an environment with only `PATH`, `HOME` and
  `TESSDATA_PREFIX`, stdin and stderr ignored, 1 MiB stdout cap, SIGKILL on a
  timeout or abort. A slot frees only after the process exits. Errors keep only
  the step name: logs and stored errors never hold tool output or OCR text.
- Data: page images are in a private temporary directory, removed after each
  PDF. The OCR text stays in memory. Findings follow the retention policy.
- Limits: `PII_PDF_OCR_MAX_PAGES` pages; `PII_PDF_OCR_TIMEOUT_MS` per PDF,
  including the wait for one of `PII_PDF_OCR_MAX_CONCURRENT` slots per process;
  eight waiters per slot, then `busy`; OCR text up to `PII_ARTIFACT_MAX_BYTES`.
  A PDF evaluation gets `PII_PROVIDER_TIMEOUT_MS + PII_PDF_OCR_TIMEOUT_MS`, which
  must stay below `SCHEDULER_JOB_TIMEOUT_MS`. A sync block-mode upload can wait
  that long. There is no memory limit per process: the container limit applies.
- OCR reads every page, also pages that have text, so a value can count twice.
  The OCR text removes spaces next to an `@`, because Tesseract often reads
  `jane@ example.com`. OCR can still misread a value: `complete` means that OCR
  read every page, not that it found every value.

Coverage (`detail.pii`, and the scan run's `pending_decision`):

| OCR result | `imageScan` | `imagesNotScanned` | UI suffix |
|---|---|---|---|
| Every page read | `complete` | absent | none |
| Stopped at the page, text, or time limit after one page or more | `partial` | `true` | "(images partly scanned)" |
| A tool failed, no page was read, or no slot was free | `failed` | `true` | "(image scan failed)" |
| OCR off | absent | `true` | "(text only)" |

`imagePagesScanned` and `imagePageCount` go with `imageScan`. Each PII detail
write replaces the coverage fields of an earlier scan (`setPiiDetail`).

Verdicts:

- Block mode accepts a PDF only when OCR is `complete`. Otherwise it rejects
  the upload: `pdf_ocr_incomplete` (422, bytes deleted), or `pdf_ocr_busy` (503,
  the client can try again).
- Detect and transform modes keep the text of the pages that OCR read and record
  `partial` or `failed`.
- A PDF with no text and no OCR text is rejected (`pdf_extraction_failed`).
- An evaluation timeout during OCR is `pii_timeout`, not a coverage result.

## Policy

- Stored policy repair (`pii-policy.ts`):
  - A malformed retention, action or detector field takes its default; the
    policy shows a warning.
  - Invalid stored provider fields (`provider.type`, `provider.model`) in
    `detect` mode: rules only, with a warning.
  - The policy is invalid when protection is on and `mode` cannot be read or is
    `off`; when `enabled` cannot be read (unless `mode` is `off`); or when
    `block` or `transform` mode has invalid stored provider fields.
  - An invalid policy stops content in scope with `pii_policy_invalid` until an
    admin saves a valid policy. Protection never turns off silently.
  - Separate case: a valid policy while the operator has not configured a
    provider (`PII_PROVIDER_ENABLED`). The mode table above applies; fix the
    operator configuration, not the tenant policy.
- An admin save sends the settings revision it loaded; a stale save gets `409
  pii_settings_conflict`.
- If an upload's scan job cannot be queued, the upload fails with
  `pii_enqueue_failed`.

