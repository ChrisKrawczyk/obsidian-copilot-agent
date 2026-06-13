import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterChatCapable,
  ModelCatalog,
  type CatalogModelInfo,
  type ModelCatalogState,
} from "./ModelCatalog";
import type { SdkClient } from "./AgentSession";

/**
 * v0.4 (model-picker) Phase 2 — ModelCatalog test suite.
 *
 * Two layers:
 *   1. Pure `filterChatCapable()` regression guard for the FR-012
 *      hard-vs-soft exclusion contract. SOFT signals (id substrings
 *      embedding|image|dall-e|whisper|tts) are LOGGED but MUST NOT
 *      be filtered out — this is the regression guard against the
 *      pre-PDR hard-exclusion gate.
 *   2. ModelCatalog state machine: loading → ready/empty/error,
 *      subscribe/notify, retry-after-failure repopulates without
 *      re-construct, identity-swap dedupe, missing-listModels error
 *      surfacing, null-client (signed-out) handling, and queued
 *      follow-up refreshes for token rotation.
 */

function makeClient(
  listModels: SdkClient["listModels"] | null,
): SdkClient {
  return {
    createSession: vi.fn(),
    ...(listModels ? { listModels } : {}),
  } as unknown as SdkClient;
}

describe("filterChatCapable — FR-012 hard/soft exclusion contract", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("HARD-excludes models with policy.state === 'disabled'", () => {
    const out = filterChatCapable([
      { id: "gpt-4.1" },
      { id: "blocked-1", policy: { state: "disabled" } },
    ]);
    expect(out.map((m) => m.id)).toEqual(["gpt-4.1"]);
  });

  it("HARD-excludes models with disabled === true", () => {
    const out = filterChatCapable([
      { id: "gpt-4o" },
      { id: "kill-switched", disabled: true } as CatalogModelInfo,
    ]);
    expect(out.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  it("passes through a fabricated 'gpt-image-reasoning' (regression guard)", () => {
    // Pre-PDR the catalog hard-excluded any id matching the soft regex.
    // Post-PDR FR-012 says SOFT signals are warn-only — a hypothetical
    // future chat model whose id contains 'image' MUST still appear.
    const out = filterChatCapable([{ id: "gpt-image-reasoning" }]);
    expect(out.map((m) => m.id)).toEqual(["gpt-image-reasoning"]);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/gpt-image-reasoning/);
  });

  it("passes through unknown-family ids unchanged (true fail-open)", () => {
    const out = filterChatCapable([{ id: "some-future-frobnicator" }]);
    expect(out.map((m) => m.id)).toEqual(["some-future-frobnicator"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs (but does not exclude) embedding/dall-e/whisper/tts soft-signal ids", () => {
    const out = filterChatCapable([
      { id: "text-embedding-ada-002" },
      { id: "dall-e-3" },
      { id: "whisper-1" },
      { id: "tts-1" },
    ]);
    expect(out.map((m) => m.id).sort()).toEqual(
      ["dall-e-3", "text-embedding-ada-002", "tts-1", "whisper-1"].sort(),
    );
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it("passes through a chat record with no extras (gpt-4o)", () => {
    const out = filterChatCapable([{ id: "gpt-4o" }]);
    expect(out.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  it("HARD-disabled signal wins even if id matches the soft regex", () => {
    const out = filterChatCapable([
      {
        id: "embedding-pro",
        disabled: true,
      } as CatalogModelInfo,
    ]);
    expect(out).toEqual([]);
  });
});

describe("ModelCatalog — state machine", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("starts in `loading` and transitions to `ready` on a populated list", async () => {
    const client = makeClient(async () => [{ id: "gpt-4.1" }]);
    const catalog = new ModelCatalog(() => client);
    expect(catalog.getState().kind).toBe("loading");
    await catalog.refresh();
    const s = catalog.getState();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.chatModels.map((m) => m.id)).toEqual(["gpt-4.1"]);
    }
  });

  it("transitions to `empty` when the SDK returns []", async () => {
    const catalog = new ModelCatalog(() => makeClient(async () => []));
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("empty");
  });

  it("transitions to `empty` when only HARD-excluded records are returned", async () => {
    const catalog = new ModelCatalog(() =>
      makeClient(async () => [
        { id: "x", policy: { state: "disabled" } },
        { id: "y", disabled: true } as CatalogModelInfo,
      ]),
    );
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("empty");
  });

  it("transitions to `error` when listModels rejects", async () => {
    const catalog = new ModelCatalog(() =>
      makeClient(async () => {
        throw new Error("network down");
      }),
    );
    await catalog.refresh();
    const s = catalog.getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.message).toBe("network down");
  });

  it("transitions to `error` when the client lacks listModels", async () => {
    const catalog = new ModelCatalog(() => makeClient(null));
    await catalog.refresh();
    const s = catalog.getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.message).toMatch(/listModels/);
  });

  it("transitions to `error` when the client provider returns null (signed-out)", async () => {
    const catalog = new ModelCatalog(() => null);
    await catalog.refresh();
    const s = catalog.getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.message).toMatch(/Not signed in/i);
  });

  it("notifies subscribers on every transition (loading → ready)", async () => {
    const client = makeClient(async () => [{ id: "gpt-4o" }]);
    const catalog = new ModelCatalog(() => client);
    const seen: ModelCatalogState["kind"][] = [];
    catalog.subscribe((s) => seen.push(s.kind));
    await catalog.refresh();
    expect(seen).toEqual(["loading", "ready"]);
  });

  it("retry after failure repopulates without re-constructing the catalog", async () => {
    let phase: "fail" | "ok" = "fail";
    const catalog = new ModelCatalog(() =>
      makeClient(async () => {
        if (phase === "fail") throw new Error("boom");
        return [{ id: "gpt-4.1" }];
      }),
    );
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("error");

    phase = "ok";
    await catalog.refresh();
    const s = catalog.getState();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.chatModels.map((m) => m.id)).toEqual(["gpt-4.1"]);
    }
  });

  it("coalesces concurrent refresh() callers into one queued follow-up", async () => {
    const listModels = vi.fn(async () => [{ id: "gpt-4.1" }]);
    const catalog = new ModelCatalog(() => makeClient(listModels));
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("runs a follow-up refresh when refresh is requested while another client call is pending", async () => {
    let releaseFirst!: (models: CatalogModelInfo[]) => void;
    const first = new Promise<CatalogModelInfo[]>((resolve) => {
      releaseFirst = resolve;
    });
    const listModels = vi
      .fn<[], Promise<CatalogModelInfo[]>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([{ id: "gpt-4o" }]);
    const catalog = new ModelCatalog(() => makeClient(listModels));

    const refreshPromise = catalog.refresh();
    expect(listModels).toHaveBeenCalledTimes(1);
    const overlapping = catalog.refresh();
    releaseFirst([{ id: "gpt-4.1" }]);
    await Promise.all([refreshPromise, overlapping]);

    expect(listModels).toHaveBeenCalledTimes(2);
    const s = catalog.getState();
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.chatModels.map((m) => m.id)).toEqual(["gpt-4o"]);
    }
  });

  it("isModelAvailable: true only when ready AND id is in chatModels", async () => {
    const catalog = new ModelCatalog(() =>
      makeClient(async () => [{ id: "gpt-4.1" }, { id: "claude-3-5-sonnet" }]),
    );
    expect(catalog.isModelAvailable("gpt-4.1")).toBe(false); // still loading
    await catalog.refresh();
    expect(catalog.isModelAvailable("gpt-4.1")).toBe(true);
    expect(catalog.isModelAvailable("claude-3-5-sonnet")).toBe(true);
    expect(catalog.isModelAvailable("nope")).toBe(false);
  });

  it("subscribe returns an unsubscribe that detaches the listener", async () => {
    const catalog = new ModelCatalog(() =>
      makeClient(async () => [{ id: "gpt-4.1" }]),
    );
    const fn = vi.fn();
    const off = catalog.subscribe(fn);
    off();
    await catalog.refresh();
    expect(fn).not.toHaveBeenCalled();
  });
});
