import { describe, expect, test } from "vitest";
import {
  decideSafety,
  SafetyState,
  isVaultPathAllowlisted,
  normaliseAllowlistEntry,
  type SafetyConfig,
} from "./SafetyPolicy";

function cfg(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    fsDefaultMode: "auto-apply-with-undo",
    vaultAllowlist: [],
    builtinAutoApprove: {},
    mcpAutoApprove: {},
    ...overrides,
  };
}

describe("normaliseAllowlistEntry", () => {
  test("strips leading slash", () => {
    expect(normaliseAllowlistEntry("/inbox/")).toBe("inbox");
    expect(normaliseAllowlistEntry("inbox")).toBe("inbox");
    expect(normaliseAllowlistEntry("/projects/alpha")).toBe("projects/alpha");
  });
  test("rejects Windows absolute and UNC", () => {
    expect(normaliseAllowlistEntry("C:\\foo")).toBe("");
    expect(normaliseAllowlistEntry("\\\\server\\share\\x")).toBe("");
  });
  test("rejects entries containing ..", () => {
    expect(normaliseAllowlistEntry("inbox/../escape")).toBe("");
  });
  test("normalises backslashes and trims trailing slash", () => {
    expect(normaliseAllowlistEntry("projects\\alpha\\")).toBe("projects/alpha");
  });
});

describe("isVaultPathAllowlisted", () => {
  test("exact match", () => {
    expect(isVaultPathAllowlisted("inbox", ["inbox"])).toBe(true);
  });
  test("prefix match with /", () => {
    expect(isVaultPathAllowlisted("inbox/today.md", ["inbox"])).toBe(true);
    expect(isVaultPathAllowlisted("inbox/sub/note.md", ["inbox"])).toBe(true);
  });
  test("non-prefix similar path is rejected", () => {
    expect(isVaultPathAllowlisted("inbox2/note.md", ["inbox"])).toBe(false);
  });
  test("leading-slash entry equivalent to no-leading-slash", () => {
    expect(isVaultPathAllowlisted("inbox/today.md", ["/inbox/"])).toBe(true);
  });
  test("no match returns false", () => {
    expect(isVaultPathAllowlisted("projects/x.md", ["inbox", "archive"])).toBe(
      false,
    );
  });
});

describe("decideSafety - vault source", () => {
  test("auto-apply in default mode", () => {
    const r = decideSafety(
      { source: "vault", vaultRelativePath: "inbox/x.md" },
      cfg({ fsDefaultMode: "auto-apply-with-undo" }),
      new SafetyState(),
    );
    expect(r.decision).toBe("auto-apply");
  });
  test("require-approval when default mode is require-approval and no allowlist hit", () => {
    const r = decideSafety(
      { source: "vault", vaultRelativePath: "inbox/x.md" },
      cfg({ fsDefaultMode: "require-approval" }),
      new SafetyState(),
    );
    expect(r.decision).toBe("require-approval");
  });
  test("allowlist overrides require-approval mode", () => {
    const r = decideSafety(
      { source: "vault", vaultRelativePath: "inbox/today.md" },
      cfg({ fsDefaultMode: "require-approval", vaultAllowlist: ["inbox"] }),
      new SafetyState(),
    );
    expect(r.decision).toBe("auto-apply");
    expect(r.reason).toMatch(/allowlist/i);
  });
  test("session grant overrides require-approval mode", () => {
    const state = new SafetyState();
    state.grantVault();
    const r = decideSafety(
      { source: "vault", vaultRelativePath: "anywhere/x.md" },
      cfg({ fsDefaultMode: "require-approval" }),
      state,
    );
    expect(r.decision).toBe("auto-apply");
  });
});

describe("decideSafety - mcp source", () => {
  test("always require-approval by default (no auto-apply default exists)", () => {
    const r = decideSafety(
      { source: "mcp", toolName: "my-mcp-server" },
      cfg({ fsDefaultMode: "auto-apply-with-undo" }),
      new SafetyState(),
    );
    expect(r.decision).toBe("require-approval");
  });
  test("per-server toggle in settings auto-approves", () => {
    const r = decideSafety(
      { source: "mcp", toolName: "trusted-server" },
      cfg({ mcpAutoApprove: { "trusted-server": true } }),
      new SafetyState(),
    );
    expect(r.decision).toBe("auto-apply");
  });
  test("per-server session grant auto-approves", () => {
    const state = new SafetyState();
    state.grantMcp("trusted-server");
    const r = decideSafety(
      { source: "mcp", toolName: "trusted-server" },
      cfg(),
      state,
    );
    expect(r.decision).toBe("auto-apply");
  });
  test("grant for a different server does not leak", () => {
    const state = new SafetyState();
    state.grantMcp("trusted-server");
    const r = decideSafety(
      { source: "mcp", toolName: "untrusted-server" },
      cfg(),
      state,
    );
    expect(r.decision).toBe("require-approval");
  });
});

describe("decideSafety - builtin source", () => {
  test("always require-approval by default", () => {
    const r = decideSafety({ source: "builtin", toolName: "shell" }, cfg(), new SafetyState());
    expect(r.decision).toBe("require-approval");
  });
  test("per-kind toggle auto-approves", () => {
    const r = decideSafety(
      { source: "builtin", toolName: "shell" },
      cfg({ builtinAutoApprove: { shell: true } }),
      new SafetyState(),
    );
    expect(r.decision).toBe("auto-apply");
  });
  test("per-kind grant does not leak across kinds", () => {
    const state = new SafetyState();
    state.grantBuiltin("shell");
    const r = decideSafety(
      { source: "builtin", toolName: "url" },
      cfg(),
      state,
    );
    expect(r.decision).toBe("require-approval");
  });
  test("vault grant does not leak into builtin", () => {
    const state = new SafetyState();
    state.grantVault();
    const r = decideSafety({ source: "builtin", toolName: "shell" }, cfg(), state);
    expect(r.decision).toBe("require-approval");
  });
});

describe("SafetyState clear()", () => {
  test("clears all grant buckets", () => {
    const s = new SafetyState();
    s.grantVault();
    s.grantMcp("a");
    s.grantBuiltin("shell");
    s.grantExtraVault("/some/root");
    s.clear();
    expect(s.isVaultGranted()).toBe(false);
    expect(s.isMcpGranted("a")).toBe(false);
    expect(s.isBuiltinGranted("shell")).toBe(false);
    expect(s.isExtraVaultGranted("/some/root")).toBe(false);
  });
});
