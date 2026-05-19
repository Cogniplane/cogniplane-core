import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminIdSchema,
  createAdminAuditEvent,
  parseAdminCrudBody,
  parseAdminCrudUpdateBody,
  parseAdminParams,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";

/**
 * Resource prefixes the generic admin CRUD machinery is allowed to emit
 * audit events for. Adding a new prefix here unlocks `${prefix}.created`,
 * `${prefix}.updated`, and `${prefix}.disabled` — those expansions must
 * also be added to `AUDIT_EVENT_TYPES` so the central enum stays in sync.
 */
type AdminCrudAuditPrefix = "admin.mcp_server";

function buildCrudAuditPayload(
  entity: Record<string, unknown>,
  input: {
    idField: string;
    includeEnabled: boolean;
  }
) {
  return {
    [input.idField]: entity[input.idField],
    version: entity.version,
    ...(input.includeEnabled ? { enabled: entity.enabled } : {})
  };
}

async function finalizeCrudMutation<TRecord extends Record<string, unknown>>(
  reply: FastifyReply,
  auditEvents: AuditEventStore,
  input: {
    entity: TRecord | null;
    entityName: string;
    responseKey: string;
    tenantId: string;
    userId: string;
    auditType: AuditEventType;
    idField: string;
    includeEnabled: boolean;
    created?: boolean;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  if (!input.entity) {
    return respondAdminNotFound(reply, `${input.entityName}_not_found`);
  }

  await createAdminAuditEvent(auditEvents, {
    tenantId: input.tenantId,
    userId: input.userId,
    type: input.auditType,
    payload: buildCrudAuditPayload(input.entity, {
      idField: input.idField,
      includeEnabled: input.includeEnabled
    }),
    ipAddress: input.ipAddress,
    userAgent: input.userAgent
  });

  if (input.created) {
    reply.code(201);
  }

  return { [input.responseKey]: input.entity };
}

export interface AdminCrudConfig<
  TBody extends z.ZodTypeAny,
  TRecord extends Record<string, unknown>,
  TCreate,
  TUpdate
> {
  resource: string;
  bodySchema: TBody;
  idField: string;
  listKey: string;
  entityName: string;
  auditPrefix: AdminCrudAuditPrefix;
  conflictMessage: string;
  updateErrorMessage: string;
  disableErrorMessage: string;
  store: {
    list: (tenantId: string, includeDisabled: boolean) => Promise<TRecord[]>;
    create: (tenantId: string, input: TCreate) => Promise<TRecord>;
    update: (tenantId: string, input: TUpdate) => Promise<TRecord | null>;
    disable: (tenantId: string, id: string) => Promise<TRecord | null>;
  };
  toCreateInput: (body: z.infer<TBody>, userId: string) => TCreate;
  toUpdateInput: (body: z.infer<TBody>, id: string) => TUpdate;
  /**
   * Optional hook for decorating list items (e.g. attaching adoption counts).
   * Failures must not break the list — implementations should swallow errors
   * and return the original records.
   */
  decorateList?: (tenantId: string, records: TRecord[]) => Promise<TRecord[]>;
}

export function registerAdminCrud<
  TBody extends z.ZodTypeAny,
  TRecord extends Record<string, unknown>,
  TCreate,
  TUpdate
>(
  app: FastifyInstance,
  auditEvents: AuditEventStore,
  config: AdminCrudConfig<TBody, TRecord, TCreate, TUpdate>
): void {
  const {
    resource,
    bodySchema,
    idField,
    listKey,
    entityName,
    auditPrefix,
    conflictMessage,
    updateErrorMessage,
    disableErrorMessage,
    store,
    toCreateInput,
    toUpdateInput,
    decorateList
  } = config;

  const paramSchema = z.object({ [idField]: adminIdSchema });

  app.get(`/admin/${resource}`, withAdmin(app, async (request) => {
    const records = await store.list(request.auth.tenantId, true);
    const decorated = decorateList
      ? await decorateList(request.auth.tenantId, records)
      : records;
    return { [listKey]: decorated };
  }));

  app.post(`/admin/${resource}`, withAdmin(app, async (request, reply) => {
    const bodyResult = parseAdminCrudBody(reply, bodySchema, request.body, idField);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    try {
      const entity = await store.create(request.auth.tenantId, toCreateInput(bodyResult.value, request.auth.userId));
      return finalizeCrudMutation(reply, auditEvents, {
        entity,
        entityName,
        responseKey: entityName,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: `${auditPrefix}.created`,
        idField,
        includeEnabled: true,
        created: true,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, conflictMessage);
    }
  }));

  app.put(`/admin/${resource}/:${idField}`, withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, paramSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseAdminCrudUpdateBody(
      reply,
      bodySchema,
      request.body,
      idField,
      paramsResult.value[idField] as string
    );
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    try {
      const entity = await store.update(
        request.auth.tenantId,
        toUpdateInput(bodyResult.value, paramsResult.value[idField] as string)
      );
      return finalizeCrudMutation(reply, auditEvents, {
        entity,
        entityName,
        responseKey: entityName,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: `${auditPrefix}.updated`,
        idField,
        includeEnabled: true,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, updateErrorMessage);
    }
  }));

  app.post(`/admin/${resource}/:${idField}/disable`, withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, paramSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const entity = await store.disable(request.auth.tenantId, paramsResult.value[idField] as string);
      return finalizeCrudMutation(reply, auditEvents, {
        entity,
        entityName,
        responseKey: entityName,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: `${auditPrefix}.disabled`,
        idField,
        includeEnabled: false,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, disableErrorMessage);
    }
  }));
}
