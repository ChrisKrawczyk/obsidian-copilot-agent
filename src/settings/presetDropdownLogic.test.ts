import { describe, expect, test } from "vitest";
import {
  applyEffectivePresetToForm,
  buildPresetDropdownModel,
} from "./presetDropdownLogic";
import type { EffectivePreset } from "./presets/effectiveRegistry";
import { BUILTIN_PACK_ID } from "./presets/BuiltInPacks";
import { SECRET_PLACEHOLDER } from "./presets/packSecretPolicy";
import type { McpServerFormInput } from "./mcpServerFormLogic";

function makeEffective(overrides: Partial<EffectivePreset> & {
  effectiveId: string;
  sourcePackId: string;
  preset: EffectivePreset["preset"];
}): EffectivePreset {
  return {
    sourcePackLabel: overrides.sourcePackLabel ?? "Pack X",
    displayLabel: overrides.displayLabel ?? overrides.preset.label,
    namespaced: overrides.namespaced ?? false,
    ...overrides,
  };
}

describe("buildPresetDropdownModel", () => {
  test("empty registry yields only the empty option and no groups", () => {
    const model = buildPresetDropdownModel([]);
    expect(model.emptyOption).toEqual({ value: "", text: "— none —" });
    expect(model.groups).toEqual([]);
  });

  test("groups by pack with Built-in first", () => {
    const registry: EffectivePreset[] = [
      makeEffective({
        effectiveId: "graph",
        sourcePackId: BUILTIN_PACK_ID,
        sourcePackLabel: "Built-in",
        preset: {
          id: "graph",
          label: "Microsoft Graph",
          server: { transport: "stdio", command: "x" },
          credentials: { kind: "none" },
        },
      }),
      makeEffective({
        effectiveId: "imported.alpha",
        sourcePackId: "imported",
        sourcePackLabel: "Imported Pack",
        preset: {
          id: "alpha",
          label: "Alpha",
          server: { transport: "stdio", command: "y" },
          credentials: { kind: "none" },
        },
        displayLabel: "Alpha (from Imported Pack)",
        namespaced: true,
      }),
    ];
    const model = buildPresetDropdownModel(registry);
    expect(model.groups).toHaveLength(2);
    expect(model.groups[0].label).toBe("Built-in");
    expect(model.groups[0].options[0].value).toBe("graph");
    expect(model.groups[1].label).toBe("From Imported Pack");
    expect(model.groups[1].options[0].text).toBe("Alpha (from Imported Pack)");
  });
});

describe("applyEffectivePresetToForm", () => {
  const baseForm: McpServerFormInput = { id: "", name: "", transport: "stdio" };

  test("static-bearer with placeholder token clears authorization and marks required", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: { transport: "http", url: "https://api.example/" },
        credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.authorization).toBe("");
    expect(form.transport).toBe("http");
    expect(form.url).toBe("https://api.example/");
    expect(requiredSecretFields).toEqual(["authorization"]);
  });

  test("static-bearer with real token does not mark required", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: { transport: "http", url: "https://api.example/" },
        credentials: { kind: "static-bearer", token: "real-token" },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.authorization).toBe("real-token");
    expect(requiredSecretFields).toEqual([]);
  });

  test("command-based preserves command/args verbatim and never marks required", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: { transport: "stdio", command: "node" },
        credentials: {
          kind: "command-based",
          command: "az",
          args: ["account", "get-access-token", "--scope", "https://example/.default"],
          tokenPath: "$.access",
          expiryPath: "$.exp",
          refreshBufferSeconds: 60,
        },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.credentialKind).toBe("command-based");
    expect(form.credentialCommand).toBe("az");
    expect(form.credentialArgs).toEqual([
      "account",
      "get-access-token",
      "--scope",
      "https://example/.default",
    ]);
    expect(form.credentialTokenPath).toBe("$.access");
    expect(form.credentialExpiryPath).toBe("$.exp");
    expect(form.credentialRefreshBufferSeconds).toBe(60);
    expect(requiredSecretFields).toEqual([]);
  });

  test("stdio preset env and cwd flow into the form", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: {
          name: "Stdio Pack Server",
          transport: "stdio",
          command: "node",
          args: ["main.js"],
          env: { NODE_ENV: "production", API_KEY: SECRET_PLACEHOLDER },
          cwd: "/some/dir",
        },
        credentials: { kind: "none" },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.transport).toBe("stdio");
    expect(form.command).toBe("node");
    expect(form.args).toEqual(["main.js"]);
    expect(form.cwd).toBe("/some/dir");
    expect(form.env).toEqual({ NODE_ENV: "production", API_KEY: "" });
    expect(requiredSecretFields).toEqual(["env.API_KEY"]);
  });

  test("none credentials sets credentialKind to none with no requireds", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: { transport: "stdio", command: "node" },
        credentials: { kind: "none" },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.credentialKind).toBe("none");
    expect(requiredSecretFields).toEqual([]);
  });

  test("env placeholders are cleared and reported as env.<KEY>", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: {
          name: "Stdio",
          transport: "stdio",
          command: "node",
          env: { API_KEY: SECRET_PLACEHOLDER, SAFE: "ok" },
        },
        credentials: { kind: "none" },
      },
    });
    const { form, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
    expect(form.env).toEqual({ API_KEY: "", SAFE: "ok" });
    expect(requiredSecretFields).toEqual(["env.API_KEY"]);
  });

  test("does not mutate the input form", () => {
    const eff = makeEffective({
      effectiveId: "x",
      sourcePackId: "p",
      preset: {
        id: "x",
        label: "X",
        server: { transport: "stdio", command: "node" },
        credentials: { kind: "none" },
      },
    });
    const original = { ...baseForm };
    applyEffectivePresetToForm(eff, original);
    expect(original).toEqual({ id: "", name: "", transport: "stdio" });
  });
});
