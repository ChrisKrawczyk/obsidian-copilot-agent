import { describe, expect, it } from "vitest";
import { collectWrittenPaths, undoEntryPaths, wrapToolsWithSelfWriteSpan } from "./selfWriteSpan";

function recorder() {
  const events: string[] = [];
  let open = 0;
  return {
    events,
    isOpen: () => open > 0,
    source: {
      beginSelfWrite: () => {
        open++;
        events.push("begin");
        return {
          end: (paths: readonly string[] = []) => {
            open--;
            events.push(`end:${paths.join(",")}`);
          },
        };
      },
    },
  };
}

describe("wrapToolsWithSelfWriteSpan", () => {
  it("runs the handler inside a span and reports written paths", async () => {
    const r = recorder();
    let openDuring = false;
    const [tool] = wrapToolsWithSelfWriteSpan(
      [
        {
          name: "move_note",
          handler: async (args: unknown) => {
            openDuring = r.isOpen();
            return { ok: true, moved: [{ from: "a.md", to: "b/a.md" }], args };
          },
        },
      ],
      r.source,
    );
    const res = await (tool.handler as (a: unknown) => Promise<unknown>)({ moves: [{ from: "a.md", to: "b/a.md" }] });
    expect(openDuring).toBe(true);
    expect(r.isOpen()).toBe(false);
    expect(r.events).toEqual(["begin", "end:a.md,b/a.md"]);
    expect((res as { ok: boolean }).ok).toBe(true);
  });

  it("closes the span when the handler throws", async () => {
    const r = recorder();
    const [tool] = wrapToolsWithSelfWriteSpan(
      [
        {
          name: "edit_note",
          handler: () => {
            throw new Error("boom");
          },
        },
      ],
      r.source,
    );
    await expect((tool.handler as (a: unknown) => Promise<unknown>)({ path: "x.md" })).rejects.toThrow("boom");
    expect(r.isOpen()).toBe(false);
    expect(r.events).toEqual(["begin", "end:x.md"]);
  });

  it("preserves every other tool field", () => {
    const r = recorder();
    const parameters = { type: "object" };
    const original = {
      name: "update_tasks",
      description: "d",
      parameters,
      skipPermission: true,
      overridesBuiltInTool: false,
      defer: "never" as const,
      metadata: { k: 1 },
      handler: async () => "ok",
    };
    const [tool] = wrapToolsWithSelfWriteSpan([original], r.source);
    const { handler: _h, ...rest } = tool;
    const { handler: _o, ...origRest } = original;
    expect(rest).toEqual(origRest);
    expect(tool.parameters).toBe(parameters);
    expect(tool.handler).not.toBe(original.handler);
  });

  it("leaves tools without a handler untouched", () => {
    const r = recorder();
    const t = { name: "x" };
    expect(wrapToolsWithSelfWriteSpan([t], r.source)[0]).toBe(t);
  });
});

describe("collectWrittenPaths", () => {
  it("collects path-like keys from args and JSON results", () => {
    const paths = collectWrittenPaths(
      { tasks: [{ path: "a.md", line: 3 }], paths: ["b.md", "c.md"], find: "x" },
      JSON.stringify({ ok: true, moved: [{ from: "d.md", to: "e/d.md" }] }),
    );
    expect(paths.sort()).toEqual(["a.md", "b.md", "c.md", "d.md", "e/d.md"]);
  });

  it("ignores non-JSON strings and non-path keys", () => {
    expect(collectWrittenPaths("plain text", { content: "path: x.md" })).toEqual([]);
  });
});

describe("undoEntryPaths", () => {
  it("lists the entry path and every batch item path", () => {
    expect(
      undoEntryPaths({
        scope: "vault",
        path: "b/a.md",
        items: [
          { op: "move", from: "a.md", to: "b/a.md" },
          { op: "modify", path: "c.md", before: "1", after: "2" },
        ],
      }),
    ).toEqual(["b/a.md", "a.md", "b/a.md", "c.md"]);
  });

  it("returns nothing for extra-vault or missing entries", () => {
    expect(undoEntryPaths(undefined)).toEqual([]);
    expect(undoEntryPaths({ scope: "extra-vault", path: "/abs/x" })).toEqual([]);
  });
});
