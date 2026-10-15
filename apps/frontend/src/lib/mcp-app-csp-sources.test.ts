import { describe, expect, it } from "vitest";
import { MCP_APP_CSP_DIRECTIVES } from "@cogniplane/shared-types";
import { intersectCspDeclarations, parseCspSource } from "@cogniplane/shared-types/csp-sources";
import { CSP_INTERSECTION_VECTORS, CSP_SOURCE_VECTORS } from "@cogniplane/shared-types/csp-source-vectors";

// The admin page checks input with the same rules as the backend. The backend
// tests run these vectors too, and the sandbox page tests run them against the
// page's own copy of the rules.

describe("the shared source rules, as the admin page loads them", () => {
  it.each(CSP_SOURCE_VECTORS.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const result = parseCspSource(vector.source, vector.directive);
    if (vector.reason === null) {
      expect(result).toMatchObject({ ok: true, source: { normalized: vector.normalized } });
    } else {
      expect(result).toEqual({ ok: false, reason: vector.reason });
    }
  });

  it.each(CSP_INTERSECTION_VECTORS.map((vector) => [vector.name, vector] as const))("intersects: %s", (_name, vector) => {
    const approved = MCP_APP_CSP_DIRECTIVES.flatMap((directive) =>
      (vector.approved[directive] ?? []).map((source) => ({ directive, source })));
    expect(intersectCspDeclarations(vector.declared, approved)).toEqual(vector.allowed);
  });
});
