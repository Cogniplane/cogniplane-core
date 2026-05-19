# Skill Bundle ADRs

This document captures the key architecture decisions behind the bundle-backed skill lifecycle described in `PRD_v2.md`.

It is intentionally short and decision-focused. The PRD explains the product scope and lifecycle. This document explains the technical choices that shape the implementation.

## ADR-001: Use immutable skill revisions as the source of change history

### Context

The platform now supports skill imports, review, activation, rollback-style recovery, runtime pinning, and cleanup. A mutable skill record alone cannot safely represent these transitions.

### Decision

Store bundle-backed skill changes as immutable entries in `admin_skill_revisions`, while `admin_skills` remains the current registry-facing projection with an `active_revision_id` pointer.

### Rationale

- Preserves exact import and review history.
- Makes activation an explicit state change instead of an overwrite.
- Supports rollback by activating an older revision.
- Enables runtime manifests and audit logs to reference stable revision ids.
- Makes cleanup decisions safe because old revisions remain distinguishable.

### Consequences

- Data modeling is more complex than a single mutable skills table.
- Registry reads require joining the active revision context.
- Review, cleanup, and audit flows become much clearer.

## ADR-002: Treat full bundle directories as the unit of runtime installation

### Context

AgentSkills bundles may include `references/`, `assets/`, and `scripts/` in addition to `SKILL.md`. A generated one-file installation loses that structure.

### Decision

Install full validated bundle directories into runtime workspaces instead of flattening skills into text-only files.

### Rationale

- Preserves the AgentSkills directory contract.
- Allows runtime access to bundled references and assets.
- Keeps installed runtime state faithful to the reviewed revision.

### Consequences

- Runtime workspace creation must copy directories, not synthesize only text files.
- Validation must enforce allowed root layout before storage and installation.
- Runtime manifests must track bundle-aware metadata such as `revisionId` and `bundleHash`.

## ADR-003: Verify installed skills through Codex, not local assumptions

### Context

Copying a skill bundle into a workspace does not guarantee Codex will discover and enable it correctly.

### Decision

Use Codex `skills/config/write` and `skills/list` during runtime startup to explicitly enable installed skill paths and verify discoverability.

### Rationale

- Codex is the runtime authority for skill visibility.
- Verification catches installation or config mismatches early.
- Startup failure is safer than silently running with missing skills.

### Consequences

- Runtime startup now depends on Codex discovery APIs.
- Lifecycle metadata must record discovery results and errors.
- Bundle-backed sessions have stricter startup validation than legacy-only sessions.

## ADR-004: Make bundle import the default admin path and legacy editing migration-only

### Context

The product needs to preserve existing text-backed skills during migration, but allowing new text-only skill creation undermines the bundle-backed model.

### Decision

Use import-driven management for new bundle-backed skills and keep direct text editing only for already-migrated legacy skills.

### Rationale

- Aligns the admin surface with the long-term architecture.
- Avoids creating new records that bypass bundle validation and revision history.
- Preserves compatibility without allowing the old model to keep expanding.

### Consequences

- The admin UI must clearly separate bundle-first flows from legacy maintenance.
- Legacy support remains in the system for migration purposes, but is no longer the canonical authoring model.

## ADR-005: Model rollback as revision activation, not a separate mechanism

### Context

Once revisions are immutable, reverting to an earlier version can be implemented by re-activating a previous revision.

### Decision

Treat rollback as a special case of activating an older revision instead of inventing a separate rollback storage model.

### Rationale

- Reuses the same activation path, audit pattern, and runtime install behavior.
- Keeps the state model simple.
- Avoids duplicate concepts for what is effectively the same registry transition.

### Consequences

- Audit events should still distinguish rollback-style activations from first-time activations.
- The admin UI may later add a dedicated rollback action, but it should remain a wrapper around revision activation.

## ADR-006: Use conservative retention with reference-aware cleanup

### Context

Shared bundle storage can grow indefinitely if old revisions are never removed, but deleting too aggressively can break active runtimes or remove operator recovery paths.

### Decision

Clean up only revisions that are inactive, outside the retention window, not the latest revision for a skill, and not referenced by active runtimes or active registry entries.

### Rationale

- Balances storage control with operational safety.
- Keeps cleanup deterministic and explainable.
- Preserves the most useful recovery points by default.

### Consequences

- Cleanup requires visibility into runtime session references and active revision pointers.
- Cleanup reporting must record keep reasons and deletion failures.
- Bundle cache paths can only be removed after confirming no remaining revision references exist.

## ADR-007: Treat auditability as part of the lifecycle, not a reporting add-on

### Context

Import, review, activation, disablement, rollback, and cleanup all affect the runtime behavior of the platform. These are operational control-plane actions.

### Decision

Record audit events for the major skill lifecycle actions as part of the core design.

### Rationale

- Operators need a durable explanation of why registry state changed.
- Cleanup and rollback decisions should be reviewable after the fact.
- Audit events make runtime and admin behavior easier to reconcile.

### Consequences

- Admin routes and lifecycle services must emit structured audit payloads.
- Audit requirements should be part of acceptance criteria for future lifecycle changes.

## Status

These ADRs reflect the implemented bundle-backed skill lifecycle and should be updated only when the underlying architecture changes.
