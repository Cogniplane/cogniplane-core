# Projects and files

Scope: projects (roles, settings, library) and artifacts (upload, storage,
download, workspace sync, PDF text). Tenant isolation and retention are in
[data](data.md).

## Projects

Projects group sessions, a file library, instructions, skills and capability
selections. Routes: `routes/projects.ts`, `project-files.ts`,
`project-members.ts`, `project-skills.ts`, `project-capabilities.ts`.

- Roles: `owner`, `editor`, `viewer` (`project_memberships`). With `visibility =
  'organization'`, every tenant member also gets `organization_role` (`viewer`
  or `editor`).
- Ownerless project (no owner who is still a tenant member): a tenant owner or
  admin lists them in Admin > Project owners (`GET /admin/projects/ownerless`)
  and makes a current member the owner (`POST
  /admin/projects/:projectId/recover-owner`, `{ userId }`; 409
  `project_has_owner` when an owner exists). Audit event:
  `project_owner_recovered` (`services/project-member-store.ts`).
- A project can be archived (`PUT /projects/:projectId/archive`) but not
  deleted; there is no delete route (`projects-delete.test.ts`).
- Check access with `requireProjectAccess` and `projectRoleSql`
  (`services/project-access.ts`). An unknown or inaccessible project returns 404
  `project_not_found`. An archived project refuses changes (409
  `project_archived`). Pass `lock: true` when a decision must not race a
  membership change.
- Settings: `approval_mode` (`organization_default`, `manual`, `automatic`;
  [effect](approvals.md)) and `agent_file_mode` (`read-only`, `create-only`,
  `read-write`), which limits the agent's project file tools
  (`services/managed-tools/project-tools.ts`).
- The library keeps file versions and folders (`project_files`,
  `project_file_versions`). `project-instructions-middleware.ts` adds project
  instructions to the model input.
- Project chats differ from normal chats in state and sandbox handling
  ([runtime](runtime.md#session-types)). A project skill release is a [sensitive
  change](sensitive-changes.md#weaker-controls-and-skill-releases).

## Artifacts

`services/artifacts/`, `routes/artifacts.ts`.

- Upload (multipart): size limit `ARTIFACT_MAX_UPLOAD_BYTES`; declared type on
  the allowlist in `lib/allowed-mime-types.ts`; when `file-type` detects a type
  from the bytes and it differs from the declared type, 415. Content with no
  detectable signature (plain text, for example) passes on its declared type.
  Filenames are cleaned for `Content-Disposition`.
- Storage key: `{userId}/{sessionId}/{uuidv7}{safeExtension}`.
  `ARTIFACT_STORAGE_BACKEND` is `local` or `bucket` (S3-compatible).
- An upload stays `pending` until its [PII](pii.md) verdict. No download token
  is issued before the artifact is `ready`.
- Download: `POST /artifacts/:artifactId/download-token` issues a short-lived
  opaque token (`ARTIFACT_DOWNLOAD_TTL_MS`). `GET /downloads/:token` is public;
  it checks the token's user, current membership and session access, then
  streams the object through the backend. No storage URL leaves the API.
- Before a turn, the artifacts that `artifactIds` in `POST /messages` selects
  are copied to `./artifacts/<name>` in the session workspace
  (`syncArtifactsToWorkspace`, `services/artifacts/artifact-workspace-sync.ts`).
  Files over `MAX_SYNC_FILE_BYTES`, and files whose copy fails, are not in the
  workspace. For those, the turn input (`services/turn-input-builder.ts`) gets
  an excerpt of readable text and PDF text, within `PER_ARTIFACT_EXCERPT_CHARS`
  and `MAX_ARTIFACT_BUDGET_CHARS`, and only metadata for other formats.
- The selection is prompt context only: the agent keeps file access to every
  artifact already copied to the workspace.
- PDF text: `ArtifactProcessor.extractArtifactText`
  (`services/artifacts/artifact-processor.ts`) runs `pdftotext`. It serves the
  turn input and `GET /artifacts/:artifactId/preview-text` (`not_a_pdf`,
  `pdf_extraction_failed`). That route and the project file version preview
  count against the shared `resource_read` rate limit
  ([data](data.md#rate-limits-and-quotas)).

