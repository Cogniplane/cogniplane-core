import { describe, expect, it } from "vitest";
import { CSP_SOURCE_ERROR_CODES, CSP_SOURCE_ERROR_MESSAGES, MCP_APP_CSP_DIRECTIVES } from "@cogniplane/shared-types";
import {
  cspSourceCovers,
  describeCspSourceError,
  groupCspEntries,
  intersectCspDeclarations,
  parseCspDeclarations,
  parseCspSource
} from "@cogniplane/shared-types/csp-sources";
import { CSP_INTERSECTION_VECTORS, CSP_SOURCE_VECTORS } from "@cogniplane/shared-types/csp-source-vectors";

// The same vectors run in the frontend tests against this file and against the
// sandbox page, so the two copies of the rules cannot drift apart.

describe("parseCspSource", () => {
  it.each(CSP_SOURCE_VECTORS.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const result = parseCspSource(vector.source, vector.directive);
    if (vector.reason === null) {
      expect(result).toMatchObject({ ok: true, source: { normalized: vector.normalized } });
    } else {
      expect(result).toEqual({ ok: false, reason: vector.reason });
    }
  });

  it("covers every failure reason in the vectors, so no rule is untested", () => {
    const covered = new Set(CSP_SOURCE_VECTORS.flatMap((vector) => vector.reason ? [vector.reason] : []));
    // A value that is not text cannot be written as a vector.
    expect([...CSP_SOURCE_ERROR_CODES].filter((code) => !covered.has(code))).toEqual(["not_a_string"]);
  });

  it.each([[undefined], [null], [42], [{}], [["https://example.com"]]])("rejects %j, which is not text", (value) => {
    expect(parseCspSource(value, "connectDomains")).toEqual({ ok: false, reason: "not_a_string" });
  });

  it("gives every reason a message for the administrator", () => {
    for (const code of CSP_SOURCE_ERROR_CODES) {
      expect(describeCspSourceError(code)).toBe(CSP_SOURCE_ERROR_MESSAGES[code]);
      expect(CSP_SOURCE_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
  });

  it("decides a wildcard with the public suffix list, not by counting labels", () => {
    for (const source of ["https://*.co.uk", "https://*.com.au", "https://*.github.io", "https://*.vercel.app",
      "https://*.s3.amazonaws.com", "https://*.blogspot.com",
      // The parent is registrable, but a rule makes every name below it a suffix.
      "https://*.kobe.jp", "https://*.compute.amazonaws.com", "https://*.foo.ck"]) {
      expect(parseCspSource(source, "connectDomains")).toEqual({ ok: false, reason: "public_suffix_wildcard" });
    }
    // Two labels with a registered domain below the suffix are fine, and so is a tenant of a hosting suffix.
    // A list exception makes a name below a registry-wide rule registrable again.
    for (const source of ["https://*.example.co.uk", "https://*.myteam.github.io", "https://*.myapp.vercel.app",
      "https://*.city.kobe.jp", "https://*.www.ck"]) {
      expect(parseCspSource(source, "connectDomains")).toMatchObject({ ok: true });
    }
  });
});

describe("cspSourceCovers", () => {
  const parse = (source: string) => {
    const result = parseCspSource(source, "connectDomains");
    if (!result.ok) throw new Error(`${source} should parse`);
    return result.source;
  };

  it("matches a name below an approved wildcard at any depth, and not the apex", () => {
    const approved = parse("https://*.example.com");
    expect(cspSourceCovers(approved, parse("https://a.example.com"))).toBe(true);
    expect(cspSourceCovers(approved, parse("https://a.b.example.com"))).toBe(true);
    expect(cspSourceCovers(approved, parse("https://example.com"))).toBe(false);
    expect(cspSourceCovers(approved, parse("https://notexample.com"))).toBe(false);
  });
});

describe("intersectCspDeclarations", () => {
  it.each(CSP_INTERSECTION_VECTORS.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const approved = MCP_APP_CSP_DIRECTIVES.flatMap((directive) =>
      (vector.approved[directive] ?? []).map((source) => ({ directive, source })));
    expect(intersectCspDeclarations(vector.declared, approved)).toEqual(vector.allowed);
  });

  it("returns nothing for a declaration that is not an object", () => {
    for (const declared of [undefined, null, "https://example.com", ["https://example.com"], 7]) {
      expect(intersectCspDeclarations(declared, [{ directive: "connectDomains", source: "https://example.com" }])).toEqual({});
    }
  });

  it("ignores a list that is not an array and a source that is not text", () => {
    const approved = [{ directive: "connectDomains" as const, source: "https://api.example.com" }];
    expect(intersectCspDeclarations({ connectDomains: "https://api.example.com" }, approved)).toEqual({});
    expect(intersectCspDeclarations({ connectDomains: [1, null, {}, "https://api.example.com"] }, approved))
      .toEqual({ connectDomains: ["https://api.example.com"] });
  });

  it("looks only at the first sources of a long list", () => {
    const declared = Array.from({ length: 60 }, (_, index) => `https://h${index}.example.com`);
    const approved = [{ directive: "connectDomains" as const, source: "https://*.example.com" }];
    expect(intersectCspDeclarations({ connectDomains: declared }, approved).connectDomains).toEqual(declared.slice(0, 25));
  });
});

describe("parseCspDeclarations", () => {
  it("keeps each well-formed source once, in normal form, for the list that declared it", () => {
    expect(parseCspDeclarations({
      resourceDomains: ["https://CDN.example.com", "https://cdn.example.com", "http://cdn.example.com"],
      connectDomains: ["wss://live.example.com", "https://*.com", "https://127.0.0.1", "https://api.example.com:443"],
      frameDomains: "https://frames.example.com",
      baseUriDomains: []
    })).toEqual([
      { directive: "resourceDomains", source: "https://cdn.example.com" },
      { directive: "connectDomains", source: "wss://live.example.com" },
      { directive: "connectDomains", source: "https://api.example.com" }
    ]);
  });

  it("returns nothing for a declaration that is not an object", () => {
    expect(parseCspDeclarations(undefined)).toEqual([]);
    expect(parseCspDeclarations("https://example.com")).toEqual([]);
    expect(parseCspDeclarations([])).toEqual([]);
  });
});

describe("groupCspEntries", () => {
  it("groups approved sources by source list and always has all four lists", () => {
    expect(groupCspEntries([])).toEqual({ resourceDomains: [], connectDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(groupCspEntries([
      { directive: "connectDomains", source: "https://a.example.com" },
      { directive: "resourceDomains", source: "https://b.example.com" },
      { directive: "connectDomains", source: "https://c.example.com" }
    ])).toEqual({
      resourceDomains: ["https://b.example.com"],
      connectDomains: ["https://a.example.com", "https://c.example.com"],
      frameDomains: [],
      baseUriDomains: []
    });
  });
});
