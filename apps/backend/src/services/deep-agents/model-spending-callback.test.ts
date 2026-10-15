import { describe, expect, it, vi } from "vitest";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";
import { createDeepAgent, createSummarizationMiddleware, StateBackend } from "deepagents";
import { ModelSpendingCallback } from "./model-spending-callback.js";

const usage = {input_tokens: 1000,output_tokens:1000,total_tokens:2000};
class MeteredModel extends FakeStreamingChatModel {
  calls = 0;
  missing = false;
  delegate = false;
  fail = false;
  override async *_streamResponseChunks() {
    const result = await this._generate();
    const message = result.generations[0]!.message;
    yield new ChatGenerationChunk({ text: "Done.", message: new AIMessageChunk({
      content: message.content, usage_metadata: message.usage_metadata, tool_calls: message.tool_calls
    }) });
  }
  override bindTools() { return this.withConfig({}); }
  override async _generate() {
    this.calls++;
    if (this.fail) throw new Error("provider unavailable");
    const message = new AIMessage({
      content: "Done.",
      ...(this.missing ? {} : { usage_metadata: usage }),
      ...(this.delegate && this.calls === 1 ? { tool_calls: [{
        name:"task",id:"delegate",args:{subagent_type:"general-purpose",description:"Answer the question"}
      }] } : {})
    });
    return { generations:[{text:"Done.",message}] };
  }
}
function setup(reservedMicroUsd = 1_000_000, modelName = "gpt-6-sol") {
  const store = {startCall:vi.fn(async()=>{}),completeCall:vi.fn(async()=>{}),failCall:vi.fn(async()=>{}),
    finish:vi.fn(async(..._args:unknown[])=>{})};
  const abort = new AbortController();
  const callback = new ModelSpendingCallback(store,{tenantId:"t",reservationId:"r",reservedMicroUsd},modelName,abort.signal);
  return { store,callback,abort,config:{callbacks:[callback]},model:new MeteredModel({}) };
}

describe("model spending callbacks with the installed SDK",()=>{
  it("waits for durable admission before dispatch and denies failed admission",async()=>{
    const t=setup();
    let resolve!:()=>void;
    t.store.startCall.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
    const pending=t.model.invoke("hello",t.config);
    await vi.waitFor(()=>expect(t.store.startCall).toHaveBeenCalledTimes(1));
    expect(t.model.calls).toBe(0);
    resolve();
    await pending;
    expect(t.store.completeCall).toHaveBeenCalledWith(expect.anything(),expect.any(String),12_000);
    t.store.startCall.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(t.model.invoke("again",t.config)).rejects.toThrow("database unavailable");
    expect(t.model.calls).toBe(1);
    await t.callback.finish();
  });
  it("does not dispatch when settlement races durable call admission", async () => {
    const t=setup();
    let resolve!:()=>void;
    t.store.startCall.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
    const pending=t.model.invoke("hello",t.config);
    const rejected=expect(pending).rejects.toThrow("allowance");
    await vi.waitFor(()=>expect(t.store.startCall).toHaveBeenCalledTimes(1));
    const finished=t.callback.finish();
    await Promise.resolve();
    expect(t.store.finish).not.toHaveBeenCalled();
    resolve();
    await rejected;
    await finished;
    expect(t.model.calls).toBe(0);
    expect(t.store.failCall).toHaveBeenCalledTimes(1);
    expect(t.store.completeCall).not.toHaveBeenCalled();
    // Settlement waits until the admitted call is recorded as failed.
    expect(t.store.finish.mock.invocationCallOrder[0]).toBeGreaterThan(t.store.failCall.mock.invocationCallOrder[0]!);
  });
  it("records a provider error as a failed call, not unknown usage", async () => {
    const t=setup();
    t.model.fail=true;
    await expect(t.model.invoke("hello",t.config)).rejects.toThrow("provider unavailable");
    expect(t.store.failCall).toHaveBeenCalledWith(expect.anything(),expect.any(String));
    expect(t.store.completeCall).not.toHaveBeenCalled();
    await expect(t.model.invoke("again",t.config)).rejects.toThrow("allowance");
    await t.callback.finish();
    expect(t.store.finish).toHaveBeenCalledTimes(1);
  });
  it("marks a call still open at the end of the turn as failed before settlement", async () => {
    const t=setup();
    await t.callback.handleChatModelStart({} as never,[],"open-call");
    await t.callback.finish();
    expect(t.store.failCall).toHaveBeenCalledWith(expect.anything(),"open-call");
    expect(t.store.finish.mock.invocationCallOrder[0]).toBeGreaterThan(t.store.failCall.mock.invocationCallOrder[0]!);
    await t.callback.handleLLMEnd({generations:[]},"open-call");
    expect(t.store.completeCall).not.toHaveBeenCalled();
  });
  it("serializes concurrent calls and stops dispatch after one call exceeds the estimate",async()=>{
    const t=setup(1);
    const result=await Promise.allSettled([t.model.invoke("a",t.config),t.model.invoke("b",t.config)]);
    expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(t.model.calls).toBe(1);
    expect(()=>t.callback.assertAllowance()).toThrow("allowance");
  });
  it("missing usage blocks subsequent work and preserves an unresolved call",async()=>{
    const t=setup();
    t.model.missing=true;
    await expect(t.model.invoke("hello",t.config)).rejects.toThrow("complete usage");
    expect(t.store.completeCall).toHaveBeenCalledWith(expect.anything(),expect.any(String),null);
    await expect(t.model.invoke("again",t.config)).rejects.toThrow("allowance");
    expect(t.model.calls).toBe(1);
  });
  it("rejects unknown prices and cancelled turns before dispatch",async()=>{
    const t=setup(1_000_000,"unpriced-model");
    await expect(t.model.invoke("hello",t.config)).rejects.toThrow("no cost estimate");
    expect(t.model.calls).toBe(0);
    const cancelled=setup();cancelled.abort.abort();
    await expect(cancelled.model.invoke("hello",cancelled.config)).rejects.toThrow("allowance");
    expect(cancelled.model.calls).toBe(0);
  });
  it("settles a turn whose first model call was refused, without an untracked call", async () => {
    const t=setup(1_000_000,"unpriced-model");
    const graph=createDeepAgent({model:t.model});
    const events:string[]=[];
    // The real callback manager runs the stream tracer and this handler together.
    await expect((async()=>{
      for await (const event of graph.streamEvents({messages:[new HumanMessage("hello")]},{...t.config,version:"v2"})) {
        t.callback.observeEvent(event as unknown as Record<string, unknown>);
        events.push(event.event);
      }
    })()).rejects.toThrow("no cost estimate");
    // The stream reported the refused start. Without the handler count, this read as an untracked call.
    expect(events).toContain("on_chat_model_start");
    expect(t.model.calls).toBe(0);
    await t.callback.finish();
    expect(t.store.startCall).not.toHaveBeenCalled();
    expect(t.store.finish).toHaveBeenCalledTimes(1);
  });
  it("records an untracked call when the stream saw a model start that the handler did not", async () => {
    const t=setup();
    // One tracked call reached the handler. The stream saw two starts (streamed=2, handled=1).
    await t.model.invoke("hello",t.config);
    t.callback.observeEvent({event:"on_chat_model_start"});
    t.callback.observeEvent({event:"on_chat_model_start"});
    await t.callback.finish();
    expect(t.store.startCall).toHaveBeenCalledTimes(1);
    // Recorded in the settlement itself, so one cannot happen without the other.
    expect(t.store.finish).toHaveBeenCalledWith(expect.anything(),{callId:"untracked-model-call",modelName:"gpt-6-sol"});
  });
  it("settles the reservation, with its untracked call, when closing an abandoned call fails", async () => {
    const t=setup();
    t.store.startCall.mockImplementationOnce(async()=>{});
    await t.callback.handleChatModelStart({} as never,[],"abandoned");
    t.callback.observeEvent({event:"on_chat_model_start"});
    t.callback.observeEvent({event:"on_chat_model_start"});
    t.store.failCall.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(t.callback.finish()).rejects.toThrow("database unavailable");
    // The reservation must not stay 'reserved' until an administrator closes it.
    expect(t.store.finish).toHaveBeenCalledTimes(1);
    expect(t.store.finish).toHaveBeenCalledWith(expect.anything(),{callId:"untracked-model-call",modelName:"gpt-6-sol"});
  });
  it("records no untracked call when the handler saw every streamed start", async () => {
    const t=setup();
    await t.model.invoke("hello",t.config);
    await expect(t.callback.handleChatModelStart({} as never,[],"refused",undefined,undefined,undefined,
      {ls_model_name:"unpriced-model"})).rejects.toThrow("no cost estimate");
    t.callback.observeEvent({event:"on_chat_model_start"});
    t.callback.observeEvent({event:"on_chat_model_start"});
    await t.callback.finish();
    expect(t.store.startCall).toHaveBeenCalledTimes(1);
    expect(t.store.finish.mock.calls).toEqual([[expect.anything()]]);
  });
  it("captures streamed usage before the graph finishes", async () => {
    const t=setup();
    const graph=createDeepAgent({model:t.model});
    const events=[];
    for await (const event of graph.streamEvents({messages:[new HumanMessage("hello")]},{...t.config,version:"v2"})) events.push(event.event);
    expect(events).toContain("on_chat_model_end");
    expect(t.store.completeCall).toHaveBeenCalledWith(expect.anything(),expect.any(String),12_000);
    expect(t.model.calls).toBe(1);
  });
  it("inherits callbacks in a real Deep Agents general-purpose subagent",async()=>{
    const t=setup();t.model.delegate=true;
    const graph=createDeepAgent({model:t.model});
    await graph.invoke({messages:[new HumanMessage("Delegate this")]},t.config);
    expect(t.model.calls).toBe(3);
    expect(t.store.startCall).toHaveBeenCalledTimes(3);
    expect(t.store.completeCall).toHaveBeenCalledTimes(3);
  });
  it("inherits callbacks in the SDK's direct summarization model call",async()=>{
    const t=setup();
    const graph=createAgent({model:t.model,middleware:[createSummarizationMiddleware({
      model:t.model,backend:(config: ConstructorParameters<typeof StateBackend>[0])=>new StateBackend(config),
      trigger:{type:"messages",value:4},keep:{type:"messages",value:2}
    })]});
    await graph.invoke({messages:Array.from({length:6},(_,i)=> i%2
      ? new AIMessage("Previous answer") : new HumanMessage("Previous question"))},t.config);
    expect(t.model.calls).toBe(2);
    expect(t.store.startCall).toHaveBeenCalledTimes(2);
    expect(t.store.completeCall).toHaveBeenCalledTimes(2);
  });
});
