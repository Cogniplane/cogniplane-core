import type { PiiProtectionSettings } from "@cogniplane/shared-types";

import type { PiiSubject } from "./pii-protection-service.js";

// Import sources in the tenant PII policy.
//
// Core scans chat prompts and direct uploads. An overlay that imports files
// into a session registers one entry for each import source, through
// `AttachOverlaysInput.piiImportScopes`. The entry connects three persisted
// values, so do not change them after release:
// - `subjectKind`: the `source` the overlay gives `UploadAdmission.admit`. The
//   scan job stores it in `pii_scan_jobs.payload_json.subjectKind`, and PII
//   audit payloads store it as `source`.
// - `scopeKey`: the key of the admin toggle in the stored `scopes` object.
// - `defaultOn`: the toggle value when the stored policy has no value for it.
//
// Each `buildAppDependencies()` makes one registry before the PII services,
// lets the overlays register, and then freezes it.

export type PiiImportScope = {
  readonly subjectKind: string;
  readonly scopeKey: string;
  readonly defaultOn: boolean;
};

// Names that core uses for its own subjects and scopes.
const RESERVED_NAMES = ["chatPrompts", "uploads", "chat_prompt", "upload", "skill_corpus"];
const SUBJECT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SCOPE_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

// Legacy compatibility. An older frontend sends this scope key on every save.
// A save accepts it even when no overlay registers it, and stores it as an
// unregistered key. Remove it when no deployed frontend sends it.
export const LEGACY_PII_SCOPE_KEYS: readonly string[] = ["microsoftImports"];

export class PiiImportScopeRegistry {
  private readonly scopes: PiiImportScope[] = [];
  private frozen = false;

  register(scope: PiiImportScope): void {
    if (this.frozen) throw new Error("PII import scopes are frozen: register them during overlay bootstrap");
    for (const [name, pattern] of [[scope.subjectKind, SUBJECT_KIND_PATTERN], [scope.scopeKey, SCOPE_KEY_PATTERN]] as const) {
      if (!pattern.test(name) || RESERVED_NAMES.includes(name)) {
        throw new Error(`Invalid or reserved PII import scope name: ${name}`);
      }
    }
    if (this.scopes.some((item) => item.subjectKind === scope.subjectKind || item.scopeKey === scope.scopeKey)) {
      throw new Error(`PII import scope already registered: ${scope.subjectKind} (${scope.scopeKey})`);
    }
    this.scopes.push({ subjectKind: scope.subjectKind, scopeKey: scope.scopeKey, defaultOn: scope.defaultOn });
  }

  /** Called once, after every overlay bootstrap, before routes and workers start. */
  freeze(): void {
    this.frozen = true;
  }

  list(): readonly PiiImportScope[] {
    return this.scopes;
  }

  findBySubjectKind(subjectKind: string): PiiImportScope | undefined {
    return this.scopes.find((item) => item.subjectKind === subjectKind);
  }

  /** Scope keys that a save accepts in addition to the core scopes. */
  requestScopeKeys(): string[] {
    const keys = this.scopes.map((item) => item.scopeKey);
    for (const key of LEGACY_PII_SCOPE_KEYS) if (!keys.includes(key)) keys.push(key);
    return keys;
  }
}

/** The scan subject for an upload source: core uploads, or a registered import. */
export function piiSubjectForSource(source: string): PiiSubject {
  return source === "upload" ? { kind: "upload" } : { kind: "import", subjectKind: source };
}

/**
 * The one scope gate. `settings` is a resolved policy (`resolvePiiPolicy`), so
 * every registered scope has a boolean. An import that no source registered
 * has no toggle, so it is in scope.
 */
export function isPiiSubjectInScope(
  settings: PiiProtectionSettings,
  subject: PiiSubject,
  registry: Pick<PiiImportScopeRegistry, "findBySubjectKind"> | undefined
): boolean {
  switch (subject.kind) {
    case "chat_prompt":
      return settings.scopes.chatPrompts;
    case "upload":
      return settings.scopes.uploads;
    case "import": {
      const scope = registry?.findBySubjectKind(subject.subjectKind);
      return scope ? settings.scopes[scope.scopeKey] !== false : true;
    }
    case "skill_corpus":
      // Always-on while PII protection itself is enabled — the corpus is an
      // aggregation boundary, not one of the per-surface tenant toggles.
      return true;
  }
}
