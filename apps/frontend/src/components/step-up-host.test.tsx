// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { request, setAccessToken } from "../lib/api-client";

const api = vi.hoisted(() => ({ stepUp: vi.fn(), fetchMySecurity: vi.fn() }));
const SECURITY = { loginType: "local", passwordChangedAt: null, totpEnabled: false, recoveryCodesRemaining: 0, mfaRequired: false };
vi.mock("../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { StepUpHost } from "./step-up-host";

const REFUSAL = { error: "step_up_required", action: "tenant.provider_key" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fetch answers in order; records each call's X-Step-Up header. */
function stubFetch(responses: Response[]) {
  const stepUpHeaders: Array<string | null> = [];
  global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    stepUpHeaders.push(new Headers(init?.headers).get("X-Step-Up"));
    return responses.shift() ?? json(500, { error: "unexpected" });
  }) as unknown as typeof fetch;
  return stepUpHeaders;
}

function mountHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><StepUpHost /></QueryClientProvider>);
}

async function confirmWithPassword(dialog: HTMLElement, label: string) {
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "owner password" } });
  const confirm = within(dialog).getByRole("button", { name: label }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
}

beforeEach(() => {
  setAccessToken("token");
  api.fetchMySecurity.mockResolvedValue(SECURITY);
  api.stepUp.mockResolvedValue("step-up-token");
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("StepUpHost", () => {
  it("asks for the action that the backend named, then the same request goes again with the token", async () => {
    mountHost();
    const stepUpHeaders = stubFetch([json(403, REFUSAL), json(200, { ok: true })]);

    const saved = request<{ ok: boolean }>("/tenant/settings", { method: "PUT", body: JSON.stringify({ provider: "openai", apiKey: "sk-x" }) });
    const dialog = await screen.findByRole("dialog", { name: "Change the provider API key" });
    expect(dialog.textContent).toContain("All owners get an email about this change.");

    await confirmWithPassword(dialog, "Save key");

    await expect(saved).resolves.toEqual({ ok: true });
    expect(api.stepUp).toHaveBeenCalledWith("tenant.provider_key", { password: "owner password" });
    expect(stepUpHeaders).toEqual([null, "step-up-token"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel sends nothing more, and the page gets an error", async () => {
    mountHost();
    const stepUpHeaders = stubFetch([json(403, REFUSAL)]);

    const saved = request("/tenant/settings", { method: "PUT", body: "{}" });
    const dialog = await screen.findByRole("dialog", { name: "Change the provider API key" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await expect(saved).rejects.toMatchObject({ code: "step_up_cancelled" });
    expect(stepUpHeaders).toEqual([null]);
    expect(api.stepUp).not.toHaveBeenCalled();
  });

  it("a refused proof stays in the dialog, so the user can try again", async () => {
    mountHost();
    stubFetch([json(403, REFUSAL), json(403, { error: "strong_step_up_required", action: "tenant.provider_key" }), json(200, { ok: true })]);

    const saved = request<{ ok: boolean }>("/tenant/settings", { method: "PUT", body: "{}" });
    const dialog = await screen.findByRole("dialog", { name: "Change the provider API key" });
    await confirmWithPassword(dialog, "Save key");

    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Confirm with your authenticator app or a passkey.");
    await confirmWithPassword(dialog, "Save key");
    await expect(saved).resolves.toEqual({ ok: true });
    expect(api.stepUp).toHaveBeenCalledTimes(2);
  });

  // The organization changes that email every owner name what they change:
  // a weaker policy or PII protection, a skill release, the skill source.
  it.each([
    ["policy.rule_create", "/admin/policy/rules", "Add the policy rule", "Add rule", "less strict for some tool calls"],
    ["policy.rule_update", "/admin/policy/rules/pol_1", "Save the policy rule", "Save rule", "less strict for some tool calls"],
    ["policy.rule_delete", "/admin/policy/rules/pol_1", "Delete the policy rule", "Delete rule", "less strict for some tool calls"],
    ["policy.rule_order", "/admin/policy/rules/order", "Change the order of the policy rules", "Save order", "less strict for some tool calls"],
    ["tenant.pii_settings", "/tenant/settings/pii", "Save the PII protection settings", "Save", "PII protection weaker"],
    ["tenant.skill_marketplace", "/tenant/settings/marketplace", "Save the skill marketplace address", "Save", "import skills from"],
    ["skill.revision_activate", "/admin/skills/notes/revisions/2/activate", "Release this skill revision", "Release", "follow this skill"],
    ["skill.publish", "/admin/skills/notes/publish", "Release this skill to all members", "Release", "follow this skill"],
    ["skill.submission_release", "/admin/skill-submissions/s-1/release", "Release the submitted skill", "Release", "follow this skill"],
    ["skill.project_release", "/projects/p-1/skills/s-1/action", "Release this project skill", "Release", "can edit this project"]
  ])("%s: the dialog names the change and says that the owners get an email", async (action, path, title, confirmLabel, what) => {
    mountHost();
    const stepUpHeaders = stubFetch([json(403, { error: "step_up_required", action }), json(200, { ok: true })]);

    const saved = request<{ ok: boolean }>(path, { method: "POST", body: "{}" });
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(dialog.textContent).toContain(what);
    expect(dialog.textContent).toContain("All owners get an email about this change.");

    await confirmWithPassword(dialog, confirmLabel);
    await expect(saved).resolves.toEqual({ ok: true });
    expect(api.stepUp).toHaveBeenCalledWith(action, { password: "owner password" });
    expect(stepUpHeaders).toEqual([null, "step-up-token"]);
  });
});
