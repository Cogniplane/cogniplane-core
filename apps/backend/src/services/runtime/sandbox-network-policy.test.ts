import { describe, expect, it, vi } from "vitest";

import {
  checkReportedNetwork,
  resolveSandboxNetworkPolicy,
  SANDBOX_DENY_ALL_EGRESS,
  sandboxNetworkMode,
  SandboxNetworkPolicyError,
  SandboxNetworkPolicyUnconfirmedError,
  SandboxTurnEndedError,
  toE2bCreateNetwork
} from "./sandbox-network-policy.js";

describe("resolveSandboxNetworkPolicy", () => {
  it("denies everything when no host is approved", () => {
    const policy = resolveSandboxNetworkPolicy([]);
    expect(policy.mode).toBe("deny-all");
    expect(policy.allowedDomains).toEqual([]);
    expect(resolveSandboxNetworkPolicy(null).hash).toBe(policy.hash);
    expect(resolveSandboxNetworkPolicy(undefined).hash).toBe(policy.hash);
  });

  it("is an allowlist when a host is approved, sorted and without duplicates", () => {
    const policy = resolveSandboxNetworkPolicy(["pypi.org", "*.example.com", "pypi.org"]);
    expect(policy.mode).toBe("allowlist");
    expect(policy.allowedDomains).toEqual(["*.example.com", "pypi.org"]);
  });

  it("gives one hash to the same hosts in any order, and a new hash when they change", () => {
    const a = resolveSandboxNetworkPolicy(["pypi.org", "files.pythonhosted.org"]);
    const b = resolveSandboxNetworkPolicy(["files.pythonhosted.org", "pypi.org", "pypi.org"]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveSandboxNetworkPolicy(["pypi.org"]).hash).not.toBe(a.hash);
    expect(resolveSandboxNetworkPolicy([]).hash).not.toBe(a.hash);
  });

  it("drops an entry that fails the host check, so the provider never receives it", () => {
    // The provider accepts every one of these, and `*` opens all web requests.
    const onRejected = vi.fn();
    const policy = resolveSandboxNetworkPolicy(
      ["pypi.org", "*", "*.com", "https://evil.example", "10.0.0.1", "Mixed.Case.com", "metadata.google.internal"],
      onRejected
    );
    expect(policy.allowedDomains).toEqual(["pypi.org"]);
    expect(onRejected).toHaveBeenCalledWith(["*", "*.com", "https://evil.example", "10.0.0.1", "Mixed.Case.com", "metadata.google.internal"]);
    expect(JSON.stringify(toE2bCreateNetwork(policy))).not.toContain("*");
  });

  it("falls back to deny-all when every entry fails", () => {
    const policy = resolveSandboxNetworkPolicy(["*", "*.com"]);
    expect(policy.mode).toBe("deny-all");
    expect(policy.hash).toBe(resolveSandboxNetworkPolicy([]).hash);
  });

  it("does not call onRejected for a clean list", () => {
    const onRejected = vi.fn();
    resolveSandboxNetworkPolicy(["pypi.org"], onRejected);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("derives the mode from the approved list alone", () => {
    expect(sandboxNetworkMode([])).toBe("deny-all");
    expect(sandboxNetworkMode(["pypi.org"])).toBe("allowlist");
  });
});

describe("provider options", () => {
  it("creates a deny-all sandbox with closed public URLs when nothing is approved", () => {
    const policy = resolveSandboxNetworkPolicy([]);
    expect(toE2bCreateNetwork(policy)).toEqual({ denyOut: [SANDBOX_DENY_ALL_EGRESS], allowPublicTraffic: false });
    expect(SANDBOX_DENY_ALL_EGRESS).toBe("0.0.0.0/0");
  });

  it("adds approved hosts as allowOut, and always keeps the deny-all entry the provider requires", () => {
    const policy = resolveSandboxNetworkPolicy(["pypi.org", "*.example.com"]);
    expect(toE2bCreateNetwork(policy)).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["*.example.com", "pypi.org"],
      allowPublicTraffic: false
    });
  });

  it("does not let a caller change the policy through the returned arrays", () => {
    const policy = resolveSandboxNetworkPolicy(["pypi.org"]);
    const create = toE2bCreateNetwork(policy);
    create.allowOut!.push("evil.example");
    expect(toE2bCreateNetwork(policy).allowOut).toEqual(["pypi.org"]);
    expect(policy.allowedDomains).toEqual(["pypi.org"]);
  });
});

describe("checkReportedNetwork", () => {
  const denyAll = resolveSandboxNetworkPolicy([]);
  const approved = resolveSandboxNetworkPolicy(["pypi.org", "*.example.com"]);

  it("accepts what a deny-all sandbox reports", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } }, denyAll
    )).toEqual({ ok: true });
  });

  it("accepts the approved hosts in any order", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org", "*.example.com"], allowPublicTraffic: false } },
      approved
    )).toEqual({ ok: true });
  });

  it("accepts extra deny entries: with the deny-all entry present they add nothing", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0", "10.0.0.0/8"], allowPublicTraffic: false } }, denyAll
    )).toEqual({ ok: true });
  });

  // A sandbox from before the policy keeps public URLs for as long as it lives,
  // and the check never skips the setting: such a sandbox is replaced.
  it.each([
    ["public URLs", { network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: true } }],
    ["an unreported URL setting", { network: { denyOut: ["0.0.0.0/0"] } }],
    ["no network configuration, as for a sandbox created without options", {}],
    ["no network configuration and no URL setting", { network: undefined }]
  ])("fails when the provider reports %s", (_label, info) => {
    expect(checkReportedNetwork(info, denyAll).ok).toBe(false);
  });

  it.each([
    ["no deny entry", { network: { allowPublicTraffic: false } }],
    ["a deny list without the all-traffic entry", { network: { denyOut: ["10.0.0.0/8"], allowPublicTraffic: false } }],
    ["an extra approved host", { network: { denyOut: ["0.0.0.0/0"], allowOut: ["evil.example"], allowPublicTraffic: false } }]
  ])("fails when the provider reports %s", (_label, info) => {
    expect(checkReportedNetwork(info, denyAll).ok).toBe(false);
  });

  it("fails on a missing approved host: the admin added a host", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org"], allowPublicTraffic: false } }, approved
    )).toEqual({ ok: false, reason: "the provider reports a different list of approved hosts" });
  });

  it("fails on approved hosts that nobody requested: the admin removed a host", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org"], allowPublicTraffic: false } }, denyAll
    )).toEqual({ ok: false, reason: "the provider reports a different list of approved hosts" });
  });

  it("fails on a deny-all sandbox when hosts were approved", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } }, approved
    ).ok).toBe(false);
  });

  it("fails on another list of the same size", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowOut: ["files.pythonhosted.org", "pypi.org"], allowPublicTraffic: false } }, approved
    ).ok).toBe(false);
  });

  // This code requests only allowOut, denyOut and allowPublicTraffic. The SDK type of the report also has
  // rules, egressProxy, maskRequestHost and httpsPorts. A report that has a value for one of them, or for a
  // name that the SDK adds later, is not a sandbox that this code made as it was sent.
  it("accepts exactly what the provider reports for a sandbox that this code created (checked live)", () => {
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } }, denyAll
    )).toEqual({ ok: true });
    expect(checkReportedNetwork(
      { network: { allowOut: ["example.com"], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } },
      resolveSandboxNetworkPolicy(["example.com"])
    )).toEqual({ ok: true });
  });

  it.each([
    ["request rules", { rules: { "example.com": [{ transform: { headers: { authorization: "Bearer x" } } }] } }, "rules"],
    ["an egress proxy", { egressProxy: { address: "proxy.example:1080", username: "u" } }, "egressProxy"],
    ["a request host mask", { maskRequestHost: "${PORT}-x.example" }, "maskRequestHost"],
    ["extra ports for HTTPS", { httpsPorts: [3000] }, "httpsPorts"],
    ["a setting that the SDK adds later", { somethingNew: { mode: "open" } }, "somethingNew"],
    ["a plain setting that the SDK adds later", { anotherSetting: true }, "anotherSetting"]
  ])("fails when the provider reports a network setting that was not requested: %s", (_label, extra, name) => {
    const network = { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false, ...extra };

    expect(checkReportedNetwork({ network }, denyAll)).toEqual({
      ok: false,
      reason: `the provider reports a network setting that was not requested (${name})`
    });
    // Also on a sandbox that was created with approved hosts.
    expect(checkReportedNetwork(
      { network: { ...network, allowOut: ["pypi.org", "*.example.com"] } }, approved
    ).ok).toBe(false);
  });

  it("accepts the object that the SDK builds from a live report: every optional name is there, with the value undefined", () => {
    // Checked live on 2026-10-14. JSON.stringify leaves these names out, so only the keys of the object show them.
    // A check of the key names, and not of the values, would refuse every sandbox that the provider made.
    const network = {
      allowOut: undefined, denyOut: ["0.0.0.0/0"], rules: undefined, egressProxy: undefined,
      allowPublicTraffic: false, maskRequestHost: undefined, httpsPorts: undefined
    };

    expect(checkReportedNetwork({ network }, denyAll)).toEqual({ ok: true });
    expect(checkReportedNetwork(
      { network: { ...network, allowOut: ["pypi.org", "*.example.com"] } }, approved
    )).toEqual({ ok: true });
  });

  // Only undefined stands for "not set". e2b@2.53.1 builds the report with every optional name present and the
  // value undefined (see the test above). Any other value, an empty one too, is a setting that was not requested.
  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["an empty text", ""],
    ["an empty list", []],
    ["an empty object", {}]
  ])("fails on a setting that was not requested when its value is %s: only undefined means that it is not set", (_label, value) => {
    for (const name of ["rules", "egressProxy", "maskRequestHost", "httpsPorts", "somethingNew"]) {
      const network = { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false, [name]: value };

      expect(checkReportedNetwork({ network }, denyAll)).toEqual({
        ok: false,
        reason: `the provider reports a network setting that was not requested (${name})`
      });
    }
    // Also next to approved hosts.
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org", "*.example.com"], allowPublicTraffic: false, rules: value } }, approved
    ).ok).toBe(false);
  });

  it("accepts undefined for every setting that was not requested, and says nothing about its key", () => {
    const network = {
      denyOut: ["0.0.0.0/0"], allowPublicTraffic: false,
      rules: undefined, httpsPorts: undefined, maskRequestHost: undefined, egressProxy: undefined, other: undefined
    };

    expect(checkReportedNetwork({ network }, denyAll)).toEqual({ ok: true });
  });

  it("names the reason, for the log and for the error", () => {
    expect(checkReportedNetwork({}, denyAll)).toEqual({
      ok: false,
      reason: "the provider reports no network configuration, so the sandbox URLs are public and egress is open"
    });
    expect(checkReportedNetwork(
      { network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: true } }, denyAll
    )).toEqual({ ok: false, reason: "the provider keeps the sandbox URLs public" });
    expect(checkReportedNetwork(
      { network: { allowPublicTraffic: false } }, denyAll
    )).toEqual({ ok: false, reason: "the provider does not deny all egress" });
  });
});

describe("network policy errors", () => {
  it("explains a policy that was not applied", () => {
    const error = new SandboxNetworkPolicyError("the provider does not deny all egress");
    expect(error.message).toBe("The sandbox network policy was not applied: the provider does not deny all egress.");
    expect(error.name).toBe("SandboxNetworkPolicyError");
  });

  it("tells the caller that nothing ran when the policy could not be confirmed", () => {
    const cause = new Error("fetch failed");
    const error = new SandboxNetworkPolicyUnconfirmedError("the provider did not answer", { cause });
    expect(error.message).toBe(
      "The sandbox network policy could not be confirmed with the provider (the provider did not answer). " +
        "No command was run. Try again."
    );
    expect(error.name).toBe("SandboxNetworkPolicyUnconfirmedError");
    expect(error.cause).toBe(cause);
    // A caller that tells the two apart must not be fooled by the other: neither is a subclass of the other.
    expect(error).not.toBeInstanceOf(SandboxNetworkPolicyError);
    expect(new SandboxNetworkPolicyError("x")).not.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
  });

  it("tells the caller that a turn that is over stopped the call, and that nothing ran", () => {
    const error = new SandboxTurnEndedError();
    expect(error.name).toBe("SandboxTurnEndedError");
    expect(error.message).toContain("the turn that asked for this operation is over");
    expect(error.message).toContain("No command was run.");
    // Code that fails closed on a check that could not be confirmed does so for this too.
    expect(error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect(error).not.toBeInstanceOf(SandboxNetworkPolicyError);
  });
});
