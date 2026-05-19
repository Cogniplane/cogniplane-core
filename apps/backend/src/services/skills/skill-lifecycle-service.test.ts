import { test, expect } from "vitest";

import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";

import { SkillLifecycleService } from "./skill-lifecycle-service.js";

test("SkillLifecycleService emits audit events for activation and rollback", async () => {
  const auditEvents = new InMemoryAuditEventStore();
  const service = new SkillLifecycleService(
    {
      async importSkillBundleFromZip() {
        throw new Error("not used");
      },
      async importSkillBundleFromGithub() {
        throw new Error("not used");
      },
      async cleanupInactiveSkillRevisions() {
        throw new Error("not used");
      },
      async activateSkillRevision() {
        return {
          skill: {
            skillId: "pdf-processing"
          },
          revision: {
            skillRevisionId: 3,
            reviewStatus: "active"
          },
          previousActiveRevisionId: 2
        };
      }
    } as never,
    auditEvents
  );

  const result = await service.activateSkillRevision("test-tenant", {
    skillId: "pdf-processing",
    skillRevisionId: 3,
    actorUserId: "admin-user",
    reviewNotes: "looks good"
  });

  expect(result?.revision.skillRevisionId).toBe(3);
  expect(auditEvents.events.map((event) => event.type)).toEqual(["admin.skill.reviewed", "admin.skill.activated", "admin.skill.rollback"]);
});
