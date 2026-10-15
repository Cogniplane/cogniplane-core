import { test, expect } from "vitest";

import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";

import { SkillLifecycleService } from "./skill-lifecycle-service.js";

function activationService(activation: {
  revisionId: number;
  revisionNumber: number;
  previousActiveRevisionId: number | null;
  previousActiveRevisionNumber: number | null;
}) {
  const auditEvents = new InMemoryAuditEventStore();
  const service = new SkillLifecycleService(
    {
      async importSkillBundleFromZip() {
        return {
          skill: { skillId: "pdf-processing", version: 4 },
          revision: { skillRevisionId: 5, sourceType: "zip", reviewStatus: "pending_review", sourceLabel: "pdf.zip" }
        };
      },
      async importSkillBundleFromGithub() {
        throw new Error("not used");
      },
      async cleanupInactiveSkillRevisions() {
        throw new Error("not used");
      },
      async activateSkillRevision() {
        return {
          skill: { skillId: "pdf-processing", version: 7, enabled: true, isPublished: true },
          revision: {
            skillRevisionId: activation.revisionId,
            revisionNumber: activation.revisionNumber,
            reviewStatus: "active"
          },
          previousActiveRevisionId: activation.previousActiveRevisionId,
          previousActiveRevisionNumber: activation.previousActiveRevisionNumber
        };
      }
    } as never,
    auditEvents
  );
  return { service, auditEvents };
}

const activate = (service: SkillLifecycleService, skillRevisionId: number) =>
  service.activateSkillRevision("test-tenant", {
    skillId: "pdf-processing",
    skillRevisionId,
    actorUserId: "admin-user",
    reviewNotes: "looks good"
  });

test("SkillLifecycleService does not emit a rollback for a forward upgrade", async () => {
  const { service, auditEvents } = activationService({
    revisionId: 3, revisionNumber: 3, previousActiveRevisionId: 2, previousActiveRevisionNumber: 2
  });

  const result = await activate(service, 3);

  expect(result?.revision.skillRevisionId).toBe(3);
  expect(auditEvents.events.map((event) => event.type)).toEqual(["admin.skill.reviewed", "admin.skill.activated"]);
  expect(auditEvents.events.find((event) => event.type === "admin.skill.activated")?.payload).toMatchObject({
    skillId: "pdf-processing", version: 7, audience: "members", isPublished: true, enabled: true
  });
  expect(auditEvents.events.find((event) => event.type === "admin.skill.reviewed")?.payload)
    .toMatchObject({ skillId: "pdf-processing", version: 7 });
});

test("SkillLifecycleService emits a rollback when the revision number goes down", async () => {
  const { service, auditEvents } = activationService({
    revisionId: 2, revisionNumber: 2, previousActiveRevisionId: 3, previousActiveRevisionNumber: 3
  });

  await activate(service, 2);

  expect(auditEvents.events.map((event) => event.type))
    .toEqual(["admin.skill.reviewed", "admin.skill.activated", "admin.skill.rollback"]);
  // Pin the direction so a from/to swap is caught: FROM the previous active
  // revision (3) TO the older revision that is now active (2).
  expect(auditEvents.events.find((event) => event.type === "admin.skill.rollback")?.payload).toMatchObject({
    skillId: "pdf-processing",
    version: 7,
    fromSkillRevisionId: 3,
    toSkillRevisionId: 2
  });
});

test("SkillLifecycleService does not emit a rollback for a first activation", async () => {
  const { service, auditEvents } = activationService({
    revisionId: 1, revisionNumber: 1, previousActiveRevisionId: null, previousActiveRevisionNumber: null
  });

  await activate(service, 1);

  expect(auditEvents.events.map((event) => event.type)).toEqual(["admin.skill.reviewed", "admin.skill.activated"]);
});

test("SkillLifecycleService includes the skill version in import audit payloads", async () => {
  const { service, auditEvents } = activationService({
    revisionId: 1, revisionNumber: 1, previousActiveRevisionId: null, previousActiveRevisionNumber: null
  });

  await service.importSkillBundleFromZip("test-tenant", {
    archiveBuffer: Buffer.from(""), originalFileName: "pdf.zip", actorUserId: "admin-user"
  });

  expect(auditEvents.events.find((event) => event.type === "admin.skill.imported")?.payload)
    .toMatchObject({ skillId: "pdf-processing", version: 4, skillRevisionId: 5 });
});
