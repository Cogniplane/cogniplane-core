import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DRAFT_STORAGE_KEY,
  MAX_RECORD_CHARS,
  MAX_SESSIONS,
  MAX_SURFACES_PER_SESSION,
  MAX_TEXT_CHARS,
  MAX_VALUES_PER_SURFACE,
  clearGenerativeUiDrafts,
  cleanValues,
  currentClearEpoch,
  digestOperations,
  loadSessionDrafts,
  ownerKey,
  saveSessionDrafts,
  type DraftScope,
  type SurfaceDraft
} from "./generative-ui-drafts.logic";

/** An in-memory Storage. `limit` is the most characters that it holds. */
class FakeStorage implements Storage {
  private readonly items = new Map<string, string>();
  constructor(private readonly limit = Infinity) {}
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) {
    if (value.length > this.limit) throw new DOMException("full", "QuotaExceededError");
    this.items.set(key, value);
  }
}

const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };
const draft = (values: SurfaceDraft["values"], overrides: Partial<SurfaceDraft> = {}): SurfaceDraft =>
  ({ target: "side-panel", count: 2, digest: "abc", values, ...overrides });
const record = (storage: FakeStorage) => JSON.parse(storage.getItem(DRAFT_STORAGE_KEY) ?? "null");

afterEach(() => vi.restoreAllMocks());

describe("cleanValues", () => {
  it("keeps false, 0, empty text, null and nested JSON", () => {
    const input = { "/a": false, "/b": 0, "/c": "", "/d": null, "/e": ["x", 1], "/f": { g: [true] } };
    expect(cleanValues(input)).toEqual({ values: input, dropped: false });
  });

  it("drops what is not JSON, what is too large, and paths that are not safe, and says so", () => {
    const tooLong = "x".repeat(MAX_TEXT_CHARS + 1);
    const result = cleanValues({
      "/ok": "kept", "/nan": Number.NaN, "/inf": Infinity, "/long": tooLong, "/fn": () => 1,
      "/date": new Date(0), "no-slash": "x", "/__proto__/x": "x", "/a/constructor": "x",
      "/deep": { a: { b: { c: { d: { e: 1 } } } } }
    });
    expect(result.values).toEqual({ "/ok": "kept" });
    expect(result.dropped).toBe(true);
  });

  it("keeps a text that fills the bound exactly, and caps the number of values", () => {
    const edge = "y".repeat(MAX_TEXT_CHARS);
    expect(cleanValues({ "/edge": edge }).values["/edge"]).toBe(edge);
    const many = Object.fromEntries(Array.from({ length: MAX_VALUES_PER_SURFACE + 5 }, (_, index) => [`/v${index}`, index]));
    const capped = cleanValues(many);
    expect(Object.keys(capped.values)).toHaveLength(MAX_VALUES_PER_SURFACE);
    expect(capped.dropped).toBe(true);
  });
});

describe("digestOperations", () => {
  const ops = [{ a: 1 }, { b: 2 }, { c: 3 }];
  it("is stable while operations are added, and changes when an earlier one changes", () => {
    expect(digestOperations([...ops, { d: 4 }], 3)).toBe(digestOperations(ops, 3));
    expect(digestOperations([{ a: 1 }, { b: 9 }, { c: 3 }], 3)).not.toBe(digestOperations(ops, 3));
    expect(digestOperations(ops, 2)).not.toBe(digestOperations(ops, 3));
  });
});

describe("ownerKey", () => {
  it("tells people and organizations apart, and does not hold their ids as text", () => {
    expect(ownerKey({ userId: "a", tenantId: "bc" })).not.toBe(ownerKey({ userId: "ab", tenantId: "c" }));
    expect(ownerKey(USER)).toBe(ownerKey({ ...USER }));
    expect(ownerKey(USER)).not.toContain("user-1");
  });
});

describe("saving and loading drafts", () => {
  it("round-trips the drafts of a session and leaves the other sessions alone", () => {
    const storage = new FakeStorage();
    expect(saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": "one" }) }, 1)).toBe("ok");
    expect(saveSessionDrafts(storage, USER, "s-2", { g: draft({ "/b": false }) }, 2)).toBe("ok");
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({ f: draft({ "/a": "one" }) });
    expect(loadSessionDrafts(storage, USER, "s-2")).toEqual({ g: draft({ "/b": false }) });
    expect(loadSessionDrafts(storage, USER, "s-3")).toEqual({});
    // An empty set removes the session, and the key when no session is left.
    saveSessionDrafts(storage, USER, "s-1", {}, 3);
    expect(Object.keys(record(storage).sessions)).toEqual(["s-2"]);
    saveSessionDrafts(storage, USER, "s-2", {}, 4);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("removes old drafts without restoring them into the new format", () => {
    const storage = new FakeStorage();
    const legacyKey = "cogniplane:generative-ui-drafts:v1";
    storage.setItem(legacyKey, JSON.stringify({
      v: 1, owner: ownerKey(USER),
      sessions: { "s-1": { at: 1, surfaces: { f: draft({ "/a": "old" }) } } }
    }));
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({});
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": "new" }) }, 2)).toBe("ok");
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({ f: draft({ "/a": "new" }) });
    expect(record(storage).v).toBe(2);
  });

  it("never reads a record of another person, and removes it", () => {
    const storage = new FakeStorage();
    saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": "secret" }) }, 1);
    expect(loadSessionDrafts(storage, { userId: "user-2", tenantId: "tenant-1" }, "s-1")).toEqual({});
    expect(loadSessionDrafts(storage, { userId: "user-1", tenantId: "tenant-2" }, "s-1")).toEqual({});
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({});
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["another format", JSON.stringify({ v: 1, owner: "x", sessions: {} })],
    ["a list", "[]"]
  ])("reads %s as empty and removes it", (_, raw) => {
    const storage = new FakeStorage();
    storage.setItem(DRAFT_STORAGE_KEY, raw);
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({});
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("drops the parts of a record that are not drafts, and keeps the rest", () => {
    const storage = new FakeStorage();
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      v: 2, owner: ownerKey(USER),
      sessions: {
        "s-1": {
          at: 1,
          surfaces: {
            good: draft({ "/a": 0 }),
            otherTarget: draft({ "/a": 1 }, { target: "elsewhere" }),
            noCount: draft({ "/a": 1 }, { count: 0 }),
            noValues: draft({}),
            hugeText: draft({ "/a": "z".repeat(MAX_TEXT_CHARS + 1) }),
            wrongType: "nope"
          }
        },
        "s-2": { at: "not a number", surfaces: {} }
      }
    }));
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual({ good: draft({ "/a": 0 }) });
    expect(loadSessionDrafts(storage, USER, "s-2")).toEqual({});
  });

  it("reports blocked storage, and succeeds with nothing to keep", () => {
    expect(saveSessionDrafts(null, USER, "s-1", { f: draft({ "/a": 1 }) }, 1)).toBe("unavailable");
    expect(saveSessionDrafts(null, USER, "s-1", {}, 1)).toBe("ok");
    expect(loadSessionDrafts(null, USER, "s-1")).toEqual({});
  });

  it(`keeps the newest ${MAX_SESSIONS} sessions`, () => {
    const storage = new FakeStorage();
    for (let index = 0; index < MAX_SESSIONS + 3; index++) {
      saveSessionDrafts(storage, USER, `s-${index}`, { f: draft({ "/a": index }) }, index);
    }
    const kept = Object.keys(record(storage).sessions);
    expect(kept).toHaveLength(MAX_SESSIONS);
    expect(kept).toContain(`s-${MAX_SESSIONS + 2}`);
    expect(kept).not.toContain("s-0");
  });

  it("keeps the newest views within the surface limit and reports omitted drafts", () => {
    const storage = new FakeStorage();
    const surfaces = Object.fromEntries(Array.from({ length: MAX_SURFACES_PER_SESSION + 2 }, (_, index) =>
      [`f${index}`, draft({ "/a": index })]));
    expect(saveSessionDrafts(storage, USER, "s-1", surfaces, 1)).toBe("full");
    const saved = record(storage).sessions["s-1"].surfaces;
    expect(Object.keys(saved)).toHaveLength(MAX_SURFACES_PER_SESSION);
    expect(saved.f0).toBeUndefined();
    expect(saved.f1).toBeUndefined();
    expect(saved[`f${MAX_SURFACES_PER_SESSION + 1}`]).toBeDefined();
    expect(loadSessionDrafts(storage, USER, "s-1")).toEqual(saved);
  });
});

describe("a full store", () => {
  it("evicts the oldest other session until the write fits", () => {
    const storage = new FakeStorage(700);
    const text = "w".repeat(150);
    saveSessionDrafts(storage, USER, "old-1", { f: draft({ "/a": text }) }, 1);
    saveSessionDrafts(storage, USER, "old-2", { f: draft({ "/a": text }) }, 2);
    expect(saveSessionDrafts(storage, USER, "now", { f: draft({ "/a": text }) }, 3)).toBe("ok");
    expect(Object.keys(record(storage).sessions)).toEqual(["old-2", "now"]);
  });

  it("removes the session instead of keeping an older copy when even it does not fit", () => {
    const storage = new FakeStorage(800);
    saveSessionDrafts(storage, USER, "other", { f: draft({ "/a": "small" }) }, 1);
    expect(saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": "first" }) }, 2)).toBe("ok");
    const result = saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": "q".repeat(2_000) }) }, 3);
    expect(result).toBe("full");
    const sessions = record(storage).sessions;
    expect(sessions["s-1"]).toBeUndefined();
    expect(sessions.other).toBeDefined();
  });

  it("refuses a record over the size bound, and does not hide behind other sessions", () => {
    const storage = new FakeStorage();
    // Each text fits its bound, and together they exceed the record bound.
    const surfaces = Object.fromEntries(Array.from({ length: 14 }, (_, index) =>
      [`f${index}`, draft({ "/a": "v".repeat(MAX_TEXT_CHARS - 1) })]));
    expect(JSON.stringify(surfaces).length).toBeGreaterThan(MAX_RECORD_CHARS);
    saveSessionDrafts(storage, USER, "other", { f: draft({ "/a": "small" }) }, 1);
    expect(saveSessionDrafts(storage, USER, "s-1", surfaces, 2)).toBe("full");
    expect(Object.keys(record(storage).sessions)).toEqual(["other"]);
  });
});

describe("clearGenerativeUiDrafts", () => {
  it("removes every draft and ends the loops that began before it", () => {
    const storage = new FakeStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    saveSessionDrafts(storage, USER, "s-1", { f: draft({ "/a": 1 }) }, 1);
    const legacyKey = "cogniplane:generative-ui-drafts:v1";
    storage.setItem(legacyKey, "old draft");
    const before = currentClearEpoch();
    clearGenerativeUiDrafts();
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(currentClearEpoch()).toBe(before + 1);
    vi.unstubAllGlobals();
  });

  it("does not throw when storage is blocked", () => {
    vi.stubGlobal("window", { get sessionStorage(): Storage { throw new DOMException("blocked", "SecurityError"); } });
    expect(() => clearGenerativeUiDrafts()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
