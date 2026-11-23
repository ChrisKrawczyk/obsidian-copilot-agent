import { describe, expect, test } from "vitest";
import { createReadTools } from "./tools/ReadTools";
import { createWriteTools } from "./tools/WriteTools";
import { createReadNoteTools } from "./tools/ReadNoteTools";
import { createSearchTools } from "./tools/SearchTools";
import { createNavigateTools } from "./tools/NavigateTools";
import { createWriteNoteTools } from "./tools/WriteNoteTools";
import { ALL_VAULT_TOOL_ENTRIES, type VaultToolEntry } from "./domain/vaultToolManifest";
import { assemblePreamble } from "./domain/PreambleAssembler";

interface RegisteredTool {
  name: string;
  description: string;
  parameters?: unknown;
  skipPermission?: boolean;
}

function registeredTools(): RegisteredTool[] {
  const stub = {} as never;
  return [
    ...createReadTools(stub),
    ...createWriteTools(stub),
    ...createReadNoteTools(stub, stub),
    ...createSearchTools(stub, stub),
    ...createNavigateTools(stub, stub),
    ...createWriteNoteTools(stub),
  ] as unknown as RegisteredTool[];
}

function schemaVocabulary(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) schemaVocabulary(s, out);
    return out;
  }
  if (!schema || typeof schema !== "object") return out;
  const o = schema as Record<string, unknown>;
  if (o.properties && typeof o.properties === "object") {
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      out.add(k);
      schemaVocabulary(v, out);
    }
  }
  if (Array.isArray(o.enum)) for (const v of o.enum) if (typeof v === "string") out.add(v);
  if (o.items) schemaVocabulary(o.items, out);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (o[key]) schemaVocabulary(o[key], out);
  return out;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/g;

/** Identifier-like words a hint presents as literal names: inside backticks, or a whole 'quoted' word. */
function hintTokens(hint: string): string[] {
  const tokens: string[] = [];
  for (const m of hint.matchAll(/`([^`]+)`/g)) tokens.push(...(m[1].match(IDENT) ?? []));
  for (const m of hint.matchAll(/(?<![A-Za-z0-9])'([A-Za-z_][A-Za-z0-9_-]*)'(?![A-Za-z0-9])/g)) tokens.push(m[1]);
  for (const m of hint.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) tokens.push(m[0]);
  return [...new Set(tokens)];
}

/** Tokens in `hint` that the tool's schema, its description, or the tool list don't back up. */
function unbackedHintTokens(entry: Pick<VaultToolEntry, "hint">, tool: RegisteredTool, toolNames: ReadonlySet<string>): string[] {
  const known = schemaVocabulary(tool.parameters);
  for (const w of tool.description.match(IDENT) ?? []) known.add(w);
  return hintTokens(entry.hint).filter((t) => !known.has(t) && !toolNames.has(t));
}

const tools = registeredTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const toolNames = new Set(byName.keys());
const FULL_OVERWRITE_TOOLS = [
  "edit_file",
  ...tools.filter((t) => JSON.stringify(t.parameters ?? {}).match(/"enum":\[[^\]]*"replace"/)).map((t) => t.name),
];

describe("vault tool manifest matches the registered tools", () => {
  test("every manifest entry is registered and every registered vault tool is in the manifest", () => {
    const manifest = ALL_VAULT_TOOL_ENTRIES.map((e) => e.name);
    expect(new Set(manifest).size).toBe(manifest.length);
    expect([...toolNames].sort()).toEqual([...manifest].sort());
  });

  test("readOnly in the manifest matches skipPermission on the tool", () => {
    const mismatched = ALL_VAULT_TOOL_ENTRIES.filter((e) => (byName.get(e.name)?.skipPermission === true) !== e.readOnly);
    expect(mismatched.map((e) => e.name)).toEqual([]);
  });

  test("hints only name parameters, modes and tools that exist", () => {
    const unbacked = Object.fromEntries(
      ALL_VAULT_TOOL_ENTRIES.map((e) => [e.name, unbackedHintTokens(e, byName.get(e.name)!, toolNames)]).filter(
        ([, tokens]) => tokens.length > 0,
      ),
    );
    expect(unbacked).toEqual({});
  });

  test("hints of full-overwrite tools say they overwrite the whole note", () => {
    expect(FULL_OVERWRITE_TOOLS).toEqual(expect.arrayContaining(["edit_file", "edit_note", "insert_into_active_note"]));
    const missing = FULL_OVERWRITE_TOOLS.flatMap((name) => {
      const hint = ALL_VAULT_TOOL_ENTRIES.find((e) => e.name === name)?.hint ?? "";
      const description = byName.get(name)?.description ?? "";
      return [
        ...(/overwrites? the whole/i.test(hint) ? [] : [`${name} hint`]),
        ...(/overwrites? the whole/i.test(description) ? [] : [`${name} description`]),
      ];
    });
    expect(missing).toEqual([]);
  });

  test("the preamble only names tools that exist", () => {
    const preamble = assemblePreamble({
      mode: "default",
      vaultRootAbsPath: "/vault",
      timezone: "UTC",
      todayInTimezone: "2026-01-01",
    });
    const named = [...preamble.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !toolNames.has(n))).toEqual([]);
  });

  test("the checker rejects a hint naming a mode the schema lacks", () => {
    const edit = byName.get("edit_note")!;
    expect(unbackedHintTokens({ hint: "Modes: `append`, 'cursor'." }, edit, toolNames)).toEqual(["cursor"]);
    expect(unbackedHintTokens({ hint: "Prefer `read_note`." }, edit, toolNames)).toEqual(["read_note"]);
    expect(unbackedHintTokens({ hint: "Then call read_note." }, edit, toolNames)).toEqual(["read_note"]);
    expect(unbackedHintTokens({ hint: "Obsidian's notes, today's date." }, edit, toolNames)).toEqual([]);
  });
});
