import { EventType, type BaseEvent } from "@ag-ui/client";
import { A2UI_VERSION, RenderUIArgsStream } from "@copilotkit/shared";
import { MAX_RENDER_UI_ARGS_CHARS } from "@cogniplane/shared-types";
import {
  GENERATIVE_UI_RENDER_TOOL, isCallErrorSurface, isGenerativeUiTarget, RenderUiTurn, type RenderUiActivity, type RenderUiCall
} from "./render-ui.js";

type StreamCall = RenderUiCall & {
  scanner?: RenderUIArgsStream;
  operations?: unknown[];
  name?: string;
  claimed?: boolean;
  oversized?: boolean;
  modelCallId?: string;
  order: number;
  index: number;
};

export class RenderUiStream {
  private readonly calls = new Map<string, StreamCall>();
  private readonly emitted = new Map<string, string>();
  private readonly previous = new Map<string, RenderUiActivity>();
  private readonly modelOrder = new Map<string, number>();
  private readonly callKeysByIndex = new Map<string, string>();
  private nextOrder = 0;

  private orderedCalls(): StreamCall[] {
    return [...this.calls.values()].sort((a, b) => a.order - b.order || a.index - b.index);
  }

  constructor(private readonly replyId: string) {}

  push(modelRun: string, chunks: unknown[]): BaseEvent[] {
    let changed = false;
    for (const raw of chunks) {
      if (!raw || typeof raw !== "object") continue;
      const chunk = raw as { id?: string; index?: number; name?: string; args?: string };
      const indexKey = `${modelRun}:index:${chunk.index ?? 0}`;
      const key = chunk.id ? `${modelRun}:id:${chunk.id}` : this.callKeysByIndex.get(indexKey) ?? indexKey;
      let call = this.calls.get(key);
      if (!call && chunk.id) {
        const unnamed = this.calls.get(indexKey);
        if (unnamed && !unnamed.modelCallId) {
          call = unnamed;
          this.calls.delete(indexKey);
          this.calls.set(key, call);
        }
      }
      if (!call) {
        if (!this.modelOrder.has(modelRun)) this.modelOrder.set(modelRun, this.nextOrder++);
        call = { id: key, input: null, status: "streaming", scanner: new RenderUIArgsStream(), operations: [],
          order: this.modelOrder.get(modelRun)!, index: chunk.index ?? this.calls.size };
        this.calls.set(key, call);
      }
      if (chunk.id) call.modelCallId = chunk.id;
      this.callKeysByIndex.set(indexKey, key);
      const newlyNamed = call.name !== GENERATIVE_UI_RENDER_TOOL && chunk.name === GENERATIVE_UI_RENDER_TOOL;
      if (chunk.name) call.name = chunk.name;
      // Buffer a bounded unnamed chunk because some providers send its name
      // later. Once a different tool is named, its arguments need no scanner.
      if ((call.name !== undefined && call.name !== GENERATIVE_UI_RENDER_TOOL) || call.oversized) continue;
      if (!chunk.args && !(call.name === GENERATIVE_UI_RENDER_TOOL && call.operations!.length > 0)) continue;
      const remaining = MAX_RENDER_UI_ARGS_CHARS + 1 - call.scanner!.text.length;
      const result = call.scanner!.push((chunk.args ?? "").slice(0, remaining));
      if (call.scanner!.text.length > MAX_RENDER_UI_ARGS_CHARS) {
        call.oversized = true;
        call.input = call.scanner!.text;
        call.status = "error";
        changed = true;
        continue;
      }
      call.operations!.push(...result.newOperations);
      if (call.name === GENERATIVE_UI_RENDER_TOOL && isGenerativeUiTarget(result.target) && call.operations!.length > 0 &&
        (call.input === null || newlyNamed || result.newOperations.length > 0)) {
        call.input = { target: result.target, operations: call.operations };
        changed = true;
      }
    }
    return changed ? this.snapshots() : [];
  }

  start(id: string, input: string): BaseEvent[] {
    // LangChain's tool run id differs from the model's tool-call id. Match the
    // completed argument object once, retaining its position among parallel calls.
    const canonical = (text: string) => {
      try { return JSON.stringify(JSON.parse(text)); } catch { return text; }
    };
    const call = this.orderedCalls().find((entry) =>
      entry.name === GENERATIVE_UI_RENDER_TOOL && !entry.claimed && entry.scanner &&
      canonical(entry.scanner.text) === canonical(input));
    if (call) {
      call.id = id;
      call.input = input;
      call.claimed = true;
      call.status = "streaming";
    } else {
      this.calls.set(`tool:${id}`, { id, input, status: "streaming", name: GENERATIVE_UI_RENDER_TOOL, claimed: true, order: this.nextOrder++, index: 0 });
    }
    return this.snapshots();
  }

  end(id: string, failed: boolean, output?: string): BaseEvent[] {
    const call = this.orderedCalls().find((entry) => entry.id === id);
    if (!call) return [];
    call.status = failed ? "error" : "ready";
    call.output = output;
    return this.snapshots();
  }

  finish(): BaseEvent[] {
    // Only started tools enter the transcript. Drop unclaimed model previews
    // after a parse failure, output limit, guard failure or interrupted stream.
    for (const [key, call] of this.calls) {
      if (!call.claimed) this.calls.delete(key);
      else if (call.status === "streaming") call.status = "error";
    }
    return this.snapshots(true);
  }

  private snapshots(final = false): BaseEvent[] {
    const turn = new RenderUiTurn(this.replyId);
    for (const call of this.orderedCalls()) {
      if (call.name === GENERATIVE_UI_RENDER_TOOL && call.input !== null) turn.set(call);
    }
    const activities = turn.activities();
    const currentIds = new Set(activities.map((activity) => activity.id));
    // Withdraw previews that have no saved call, or whose final input rejected
    // the surface. Replaying the delete also removes it from the SDK manager.
    // Before the run ends, a withdrawn surface gets no delete, so a retry in
    // this turn can create its id again. The error activity of a call has no
    // surface id of the model, so it is deleted at once: the chat shows an
    // activity with no operations and no rejections as an empty card. A call
    // gets a new id when its tool starts, which withdraws its preview error.
    for (const [id, old] of this.previous) {
      if (currentIds.has(id)) continue;
      const remove = final || isCallErrorSurface(old.content.surfaceId);
      activities.push({ ...old, content: { ...old.content,
        operations: remove ? [...old.content.operations.filter((operation) => !("deleteSurface" in operation)),
          { version: A2UI_VERSION, deleteSurface: { surfaceId: old.content.surfaceId } }] : [],
        status: remove ? "ready" : "error", rejected: [] } });
    }
    const events: BaseEvent[] = [];
    for (const activity of activities) {
      const serialized = JSON.stringify(activity.content);
      if (this.emitted.get(activity.id) === serialized) continue;
      this.emitted.set(activity.id, serialized);
      this.previous.set(activity.id, activity);
      events.push({ type: EventType.ACTIVITY_SNAPSHOT, messageId: activity.id,
        activityType: activity.activityType, content: activity.content } as BaseEvent);
    }
    return events;
  }
}
