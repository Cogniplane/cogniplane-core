import {
  A2UI_VERSION, GENERATIVE_UI_ACTIVITY_TYPE, GENERATIVE_UI_RENDER_TOOL,
  generativeUISurfaceMessageId, getOperationKind, getOperationSurfaceId,
  type A2UIOperation, type GenerativeUIRejectedOperation, type GenerativeUISurfaceContent
} from "@copilotkit/shared";
import {
  GENERATIVE_UI_CATALOG_ID, GENERATIVE_UI_TARGETS, MAX_RENDER_UI_ARGS_CHARS, MAX_RENDER_UI_OPERATIONS,
  type GenerativeUiTarget
} from "@cogniplane/shared-types";
import { z } from "zod";

export { GENERATIVE_UI_RENDER_TOOL };

// Component props are checked by the browser against the safe catalog. The
// backend checks the protocol, target, limits and this turn's surface lifecycle.
// The target allowlist is fixed: a call cannot name another place in the app.
const id = z.string().min(1).max(200);
const components = z.array(z.object({ id, component: id }).passthrough()).min(1).max(200);
const payload = z.object({ surfaceId: id });
const operationSchema = z.union([
  z.object({ version: z.literal(A2UI_VERSION), createSurface: payload.extend({
    catalogId: z.literal(GENERATIVE_UI_CATALOG_ID).optional(),
    components: components.optional(), dataModel: z.record(z.string(), z.unknown()).optional(),
    sendDataModel: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional()
  }).strict() }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), updateComponents: payload.extend({ components }).strict() }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), updateDataModel: payload.extend({
    path: z.string().optional(), value: z.unknown()
  }).strict().refine((v) => Object.hasOwn(v, "value")) }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), deleteSurface: payload.strict() }).strict()
]);

// Keep the model schema simple. Malformed operations return a normal tool
// error with reasons, rather than aborting the agent loop during argument parsing.
export const renderUiArgsSchema = z.object({
  target: z.unknown().optional().describe(
    "A target that the browser guide lists. Updates keep the target of the createSurface."
  ),
  operations: z.unknown().optional().describe(
    `An array of A2UI v1.0 operations. Create a surface before updating it. At most ${MAX_RENDER_UI_OPERATIONS} operations.`
  )
}).passthrough();

/** The tool result of a call in a turn without the browser UI transport. The
 *  tool checks nothing then. */
export const RENDER_UI_TRANSPORT_DISABLED = "Browser UI transport is not enabled for this turn.";

export type RenderUiCall = {
  id: string;
  input: unknown;
  status: "streaming" | "ready" | "error";
  /** The tool result, when the tool returned one. */
  output?: string;
};
export type RenderUiActivity = {
  id: string;
  role: "activity";
  activityType: typeof GENERATIVE_UI_ACTIVITY_TYPE;
  content: GenerativeUISurfaceContent;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isGenerativeUiTarget(value: unknown): value is GenerativeUiTarget {
  return (GENERATIVE_UI_TARGETS as readonly unknown[]).includes(value);
}

// A call that shows no surface reports its errors in an activity of its own.
// Its id names the call, so it is never the id of a surface of the model.
const CALL_ERROR_PREFIX = "error:";

export function isCallErrorSurface(surfaceId: string): boolean {
  return surfaceId.startsWith(CALL_ERROR_PREFIX);
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try { return JSON.parse(input); } catch { return null; }
}

// The same reducer serves tool execution, streamed snapshots and saved history.
// Calls retain their model ids; only the activity view gets a reply namespace.
export class RenderUiTurn {
  private readonly calls = new Map<string, RenderUiCall>();

  constructor(private readonly replyId: string) {}

  set(call: RenderUiCall): void { this.calls.set(call.id, call); }

  result(callId: string): { rendered: string[]; rejected: GenerativeUIRejectedOperation[] } {
    return this.build().results.get(callId) ?? { rendered: [], rejected: [] };
  }

  activities(): RenderUiActivity[] { return [...this.build().activities.values()]; }

  private build() {
    const known = new Set<string>();
    const created = new Set<string>();
    // The target of each surface, from its createSurface. A later call cannot
    // move the surface: the SDK would show it in the new place.
    const targets = new Map<string, GenerativeUiTarget>();
    const activities = new Map<string, RenderUiActivity>();
    const results = new Map<string, { rendered: string[]; rejected: GenerativeUIRejectedOperation[] }>();
    for (const call of this.calls.values()) {
      const input = parseInput(call.input);
      const rejected: GenerativeUIRejectedOperation[] = [];
      const rendered = new Set<string>();
      let invalid: string | undefined;
      const size = typeof call.input === "string" ? call.input.length : JSON.stringify(call.input ?? null).length;
      // The tool refused this call without a check. It applies no operation,
      // as the tool also assumes when it checks the calls after it.
      if (call.output === RENDER_UI_TRANSPORT_DISABLED) invalid = RENDER_UI_TRANSPORT_DISABLED;
      else if (size > MAX_RENDER_UI_ARGS_CHARS) invalid = `Arguments exceed ${MAX_RENDER_UI_ARGS_CHARS} characters`;
      else if (!record(input) || !isGenerativeUiTarget(input.target) || !Array.isArray(input.operations)) {
        invalid = `Expected target ${GENERATIVE_UI_TARGETS.map((target) => `"${target}"`).join(" or ")} and an operations array`;
      } else if (input.operations.length === 0 || input.operations.length > MAX_RENDER_UI_OPERATIONS) {
        invalid = `Use 1 to ${MAX_RENDER_UI_OPERATIONS} operations`;
      }
      if (invalid) {
        // Do not accept partial operations from an invalid final argument object.
        rejected.push({ index: 0, reason: invalid });
      } else {
        const { operations, target } = input as { operations: unknown[]; target: GenerativeUiTarget };
        for (const [index, raw] of operations.entries()) {
          const parsed = operationSchema.safeParse(raw);
          const kind = getOperationKind(raw);
          const surfaceId = getOperationSurfaceId(raw);
          let reason: string | undefined;
          if (!parsed.success) reason = "Use one supported v1.0 surface operation with valid fields; renderer functions are disabled";
          else if (kind === "createSurface" && created.has(surfaceId!)) reason = "Surface id already used in this turn";
          else if (kind !== "createSurface" && !known.has(surfaceId!)) reason = "Create this surface in the current turn first";
          else if (kind !== "createSurface" && targets.get(surfaceId!) !== target) {
            reason = `This surface has target "${targets.get(surfaceId!)}". Keep its target, or create a new surface`;
          }
          if (reason) { rejected.push({ index, reason }); continue; }
          const ns = `turn:${this.replyId}:${surfaceId}`;
          if (kind === "createSurface") { known.add(surfaceId!); created.add(surfaceId!); targets.set(surfaceId!, target); }
          if (kind === "deleteSurface") known.delete(surfaceId!);
          let activity = activities.get(`surface:${surfaceId}`);
          if (!activity) {
            activity = {
              id: generativeUISurfaceMessageId(ns), role: "activity", activityType: GENERATIVE_UI_ACTIVITY_TYPE,
              content: { surfaceId: ns, target: targets.get(surfaceId!)!, catalogId: GENERATIVE_UI_CATALOG_ID,
                operations: [], status: call.status, rejected: [] }
            };
            activities.set(`surface:${surfaceId}`, activity);
          }
          const op = parsed.data as A2UIOperation;
          const operationPayload = (op as unknown as Record<string, Record<string, unknown>>)[kind!]!;
          activity.content.operations.push({ ...op, [kind!]: { ...operationPayload, surfaceId: ns } } as A2UIOperation);
          activity.content.status = call.status;
          rendered.add(surfaceId!);
        }
      }
      if (call.status === "error" && rejected.length === 0) {
        rejected.push({ index: 0, reason: "The UI tool did not complete successfully" });
      }
      // A failed or malformed call must have a visible error even without a
      // surface. It stays in the chat, whatever target the call named, so it
      // never replaces the view in the side panel.
      if (rendered.size === 0 && (rejected.length > 0 || call.status === "error")) {
        const ns = `${CALL_ERROR_PREFIX}turn:${this.replyId}:${call.id}`;
        activities.set(`error:${call.id}`, {
          id: generativeUISurfaceMessageId(ns), role: "activity", activityType: GENERATIVE_UI_ACTIVITY_TYPE,
          content: { surfaceId: ns, target: "chat", catalogId: GENERATIVE_UI_CATALOG_ID,
            operations: [], status: "error", rejected }
        });
      }
      for (const surfaceId of rendered) {
        const content = activities.get(`surface:${surfaceId}`)!.content;
        content.rejected.push(...rejected);
        if (rejected.length > 0) content.status = "error";
      }
      results.set(call.id, { rendered: [...rendered], rejected });
    }
    return { activities, results };
  }
}
