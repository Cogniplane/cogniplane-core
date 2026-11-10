# Skills

Scope: skill import, revisions, bundle storage, runtime loading, personal and
project skills, the marketplace, skill telemetry, and capability resolution.
Long-term memory is in [memory](memory.md).

## Skill model

- `admin_skills` is the registry. `active_revision_id` points to the live
  revision. The content of an `admin_skill_revisions` row (name, description,
  instructions, bundle) never changes; its review and activation fields do.
- A revision stores `skillName`, `description` and `instructions` in its
  `metadata` JSONB (`metadata->>'instructions'`, not a column). Activation fails
  without all three.
- `bundle_storage_uri` is `file://` or `s3://`; null means inline instructions
  without a bundle.
- Rollback is activation of an older revision. There is no separate rollback
  mechanism.
- Releases are [sensitive
  changes](sensitive-changes.md#weaker-controls-and-skill-releases).

## Import and lifecycle

Admin routes are in `routes/admin/admin-skill-routes.ts`: imports (zip, GitHub,
inline text), revision review, activation, release impact, publish and disable,
and revision cleanup.

Pipeline (files under `services/`):

1. `validateSkillBundle` (`skills/skill-bundle-validator.ts`)
2. `buildSkillImportPayload` (`skills/skill-import-service.ts`)
3. `importSkillBundle` (`skills/skill-revision-store.ts`): merges name,
   description and instructions into `metadata`
4. `activateSkillRevision` (`skills/skill-lifecycle-service.ts`)
5. `compileRuntimeConfig` (`dynamic-config-service.ts`)
6. `buildSkillsLibraryFiles` (`deep-agents/deep-agents-skills-library.ts`),
   called when the runtime session starts

Import validation (`skill-import-service.ts`, `skill-bundle-validator.ts`,
`skill-bundle-limits.ts`) applies to zip uploads and GitHub archives:

- Compressed size at most `ARTIFACT_MAX_UPLOAD_BYTES`, checked before parsing.
- Per-file, total-uncompressed and file-count limits in
  `skill-bundle-limits.ts`; each entry must declare its size, and the decoded
  length must match.
- Paths are POSIX-normalized; absolute paths and `..` are rejected; the result
  must stay under the extraction root. A GitHub subdirectory must stay inside
  the archive.
- Symlinks are errors; other non-regular files are skipped.
- Bundle root allows only the files `SKILL.md`, `README.md`, `LICENSE` (exact
  names) and the directories `assets/`, `references/`, `scripts/`.
- GitHub archives are fetched with `ssrfSafeAgent`
  ([security](../security.md#outbound-requests)).

Stored `.tar.gz` bundles were validated at import. Materialization does not
repeat these checks; it extracts with `strict: true` and accepts files and
directories only.

Retention: an admin runs cleanup with `POST /admin/skills/revisions/cleanup`;
send `{"dryRun": true}` first to see the report (the default is `false`). It
deletes only revisions older than `SKILL_BUNDLE_RETENTION_DAYS` that are not
active, not the latest of their skill, and not used by an active runtime
(`domain/skill-cleanup-policy.ts`), and deletes a bundle only when no other
revision points to it. No scheduler runs it. Every lifecycle action writes an
audit event.

## Bundle storage

`skill-bundle-storage.ts`; `SKILL_BUNDLE_STORAGE_BACKEND` selects the backend.

- `local`: `<SKILL_BUNDLE_STORAGE_ROOT>/<tenantId>/<bundleName>/<contentHash>/`.
  The tenant directory keeps cleanup per tenant. Use a persistent volume.
- `bucket`:
  `s3://<bucket>/<prefix>/skills/<tenantId>/<skillId>/<revisionNumber>-<contentHash>.tar.gz`,
  with the artifact bucket connection settings, `SKILL_BUNDLE_BUCKET_NAME` and
  `SKILL_BUNDLE_BUCKET_PREFIX`. `materializeBundle` downloads and extracts into
  `SKILL_BUNDLE_CACHE_ROOT`.
- A stored URI whose scheme does not match the configured backend is an error.
  No tool moves bundles or artifacts between local and bucket storage: choose
  the backend before tenants store files, or copy the objects and rewrite the
  stored URIs yourself.
- The content hash names the object. Materialization does not verify the bytes
  against it, so protect the bucket against writes by others.

## Runtime loading

- `buildSkillsLibraryFiles`
  (`services/deep-agents/deep-agents-skills-library.ts`) serves each enabled
  skill as read-only `/skills/<slug>/SKILL.md` plus its bundle files, through a
  `CompositeBackend` route of the agent file tools. `execute` cannot read it; it
  is not copied into the sandbox.
- While a bundle stays cached, its companion files are read once per backend
  process and shared across sessions.
  `SkillCompanionCache` (same file) keeps one copy of each bundle's companion
  files, and all sessions use it. The key is the storage backend instance and
  the full storage URI; both URI layouts hold the tenant id and the content
  hash. Concurrent builds of one bundle share one read. A failed read is not
  kept, so the next build reads again.
- Cache limits (code constants `COMPANION_CACHE_MAX_BYTES` and
  `COMPANION_CACHE_MAX_ENTRIES`): 64 MiB of file bytes and 256 bundles. The
  cache removes the least recently used bundle first and does not keep a
  bundle larger than 64 MiB. A removed bundle stays in memory while a session
  that serves it is alive; the next build reads it again.
- Each build still calls `materializeBundle`, so the storage checks the path
  again. If storage reports the bundle unavailable, the build does not serve
  its cached companions. Their bytes stay in memory
  until eviction or a restart. Each build also generates `SKILL.md` from the
  current revision. The `/skills/` backend returns copies of binary content,
  so a caller cannot change the shared bytes.
- Not verified: the byte limit counts file bytes, not process memory, and a
  decoded text file can use up to two times its file size. No memory benchmark
  under production load exists. The cache does not read a bundle again when its
  bytes change under the same URI (see the content hash note in [bundle
  storage](#bundle-storage)); the change shows after eviction or a restart.
- The deepagents skills middleware puts only each skill's name, description and
  path in the system prompt; the instructions stay in the file, and the model
  reads `SKILL.md` when it needs it.
- `ActivationTracker` writes `resource_activations`: `materialized` when a skill
  is available in a turn, `invoked` when a gateway tool call matches the skill's
  `associatedToolIds`.

## Personal, project and organization skills

- Personal skills (`routes/personal-skills.ts`, `/me/skills`, migration `052`):
  a member writes or imports one `SKILL.md` (no companion files, no remote
  import), saves drafts, and releases explicitly. Release activates the latest
  revision and adds it to the member's custom defaults. Limits:
  `MAX_PERSONAL_SKILLS` and `MAX_PERSONAL_SKILL_REVISIONS`
  (`personal-skill-store.ts`). Only the owner's normal chats load them; project,
  scheduled and skill-improvement sessions do not. They cannot grant tools or
  override policy. Audit events omit their text.
- Personal defaults (`/settings/capabilities`,
  `routes/personal-capabilities.ts`): a null selection inherits organization
  defaults plus released personal skills; an empty custom selection selects
  nothing. Resolution order: [capability resolution](#capability-resolution).
- Project skills: `routes/project-skills.ts`. A release gives the skill to the
  project's editors, or to all members when the organization can edit.
- Member submissions: `routes/organization-skill-submissions.ts`. Releasing a
  submission is an admin action.
- Marketplace: a manifest URL per tenant (or `SKILL_MARKETPLACE_MANIFEST_URL`),
  cached for `SKILL_MARKETPLACE_CACHE_TTL_MS`. The manifest schema is
  `marketplaceManifestSchema` in `services/skills/skill-marketplace-service.ts`.
  Minimal manifest: `{"version": 1, "skills": [{"slug": "pdf-tools", "name":
  "PDF tools", "description": "Read and split PDFs", "repoUrl":
  "https://github.com/acme/skills", "subdirectory": "pdf-tools"}]}`. Setting the
  URL is a [sensitive
  change](sensitive-changes.md#weaker-controls-and-skill-releases).
- Skill improvement is a normal turn: the built-in `skill-improver` skill calls
  the `read_skill_corpus` managed tool, which returns a redacted corpus of
  recent sessions plus the current `SKILL.md`; the agent proposes a new version
  with `write_artifact`. The corpus reads only the caller's own normal sessions
  (`services/skills/skill-improvement-corpus.ts`) and passes the PII check
  ([PII](pii.md)).

## Capability resolution

Order (`routes/session-capabilities.ts`):

1. Catalog: the tenant's (Admin > Agent behavior, `/admin/capabilities`), plus
   the owner's personal skills in a normal chat, or the project skills in a
   project chat (`DynamicConfigService`).
2. Defaults: the project's selection (`routes/project-capabilities.ts`) in a
   project chat; else the member's personal defaults (`/settings/capabilities`);
   else all of the catalog.
3. The chat's own selection narrows the defaults.

Steps 2 and 3 only remove items. Policy and approvals apply after.
