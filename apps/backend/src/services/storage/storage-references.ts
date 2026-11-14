/**
 * The one list of database columns that name a stored object, and the SQL that
 * decides if an object is still in use.
 *
 * Two storage classes use different backends, so their locators never mix:
 *
 * - `artifact_object`: a key in the artifact storage (`ArtifactStorage`).
 *   Artifacts and project file versions share these keys: a promotion or a
 *   restore copies the key, not the bytes.
 * - `skill_bundle`: a URI in the skill bundle storage (`SkillBundleStorage`).
 *
 * Each column has one role:
 *
 * - `live`: a row that keeps its object. A delete must check every live
 *   column of the class, in every tenant.
 * - `derived`: a copy of a live locator that a foreign key removes with its
 *   source row. It never keeps an object by itself.
 * - `queue`: a cleanup queue that owns a locator until the object is gone. A
 *   queue row never keeps an object, so two queues that hold the same locator
 *   cannot keep each other forever.
 *
 * `storage-references.integration.test.ts` reads the catalog and fails for a
 * locator column that this list does not name. A new table that stores a key
 * or a bundle URI must get an entry here, a reference check below when it is
 * `live`, and an entry in the tenant deletion queue
 * (`services/tenant-deletion-service.ts`).
 */

export type StorageClass = "artifact_object" | "skill_bundle";
export type StorageLocatorRole = "live" | "derived" | "queue";

export type StorageLocatorColumn = {
  table: string;
  column: string;
  storage: StorageClass | "mixed";
  role: StorageLocatorRole;
  /** Why the column has this role, or which rows of a live column do not count. */
  note: string;
};

export const STORAGE_LOCATOR_COLUMNS: readonly StorageLocatorColumn[] = [
  {
    table: "artifacts",
    column: "storage_key",
    storage: "artifact_object",
    role: "live",
    note:
      "Except a row with status 'deleted', and a row that a PII rejection released " +
      "(storage_released_at). A released row keeps its verdict, not its object."
  },
  {
    table: "project_file_versions",
    column: "storage_key",
    storage: "artifact_object",
    role: "live",
    note: "Every version keeps its object; project retention ignores only the versions it deletes."
  },
  {
    table: "artifact_download_tokens",
    column: "storage_key",
    storage: "artifact_object",
    role: "derived",
    note: "A copy of the artifact key; the token row cascades with its artifact."
  },
  {
    table: "session_storage_gc",
    column: "storage_key",
    storage: "artifact_object",
    role: "queue",
    note: "Session purge and PII rejection queue keys here."
  },
  {
    table: "project_file_storage_gc",
    column: "storage_key",
    storage: "artifact_object",
    role: "queue",
    note: "Project file retention queues keys here."
  },
  {
    table: "admin_skill_revisions",
    column: "bundle_storage_uri",
    storage: "skill_bundle",
    role: "live",
    note: "Null means an inline revision without a bundle. The 'system' tenant shares its rows."
  },
  {
    table: "skill_bundle_storage_gc",
    column: "storage_uri",
    storage: "skill_bundle",
    role: "queue",
    note: "Skill revision cleanup queues bundle URIs here."
  },
  {
    table: "tenant_deletion_cleanup",
    column: "locator",
    storage: "mixed",
    role: "queue",
    note: "Tenant deletion work; `kind` tells the storage class (or a runtime thread, or Redis)."
  }
];

/**
 * True for an artifact row that keeps its object. `alias` names the
 * `artifacts` row.
 */
export function liveArtifactSql(alias: string): string {
  return `(${alias}.status <> 'deleted' AND ${alias}.storage_released_at IS NULL)`;
}

/**
 * True when a live row in any tenant references the artifact object `key` (a
 * SQL expression). Queue rows do not count.
 *
 * It has no tenant predicate on purpose: one object can have references in
 * more than one tenant. Run it on a pool that sees every tenant (the
 * maintenance or migration pool). On `app_user`, RLS hides the other tenants
 * and the check can report an object in use elsewhere as unused.
 *
 * `ignoreProjectFileVersion(alias)` is a SQL condition on the
 * `project_file_versions` row `alias`: a matching version does not count. The
 * project file retention uses it for the versions that its own transaction
 * deletes.
 */
export function artifactObjectReferencedSql(
  key: string,
  options: { ignoreProjectFileVersion?: (alias: string) => string } = {}
): string {
  const ignored = options.ignoreProjectFileVersion
    ? ` AND NOT (${options.ignoreProjectFileVersion("live_version")})`
    : "";
  return `(EXISTS (
      SELECT 1 FROM project_file_versions live_version
      WHERE live_version.storage_key = ${key}${ignored}
    ) OR EXISTS (
      SELECT 1 FROM artifacts live_artifact
      WHERE live_artifact.storage_key = ${key} AND ${liveArtifactSql("live_artifact")}
    ))`;
}

/**
 * True when a skill revision in any tenant, or of the `system` tenant, names
 * the bundle `uri` (a SQL expression). Queue rows do not count. Same pool
 * rule as `artifactObjectReferencedSql`.
 */
export function skillBundleReferencedSql(uri: string): string {
  return `EXISTS (
      SELECT 1 FROM admin_skill_revisions live_revision
      WHERE live_revision.bundle_storage_uri = ${uri}
    )`;
}
