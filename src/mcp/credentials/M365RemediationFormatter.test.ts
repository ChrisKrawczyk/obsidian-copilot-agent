import { describe, expect, test } from "vitest";
import { M365RemediationFormatter, isAzExecutable } from "./M365RemediationFormatter";
import { DefaultRemediationFormatter, type RemediationContext } from "./RemediationFormatter";

function ctx(overrides: Partial<RemediationContext> = {}): RemediationContext {
  return {
    variant: "command-based",
    command: "az account get-access-token --scope x --output json",
    lastTenantId: null,
    error: { kind: "unauthorized" },
    ...overrides,
  };
}

describe("M365RemediationFormatter", () => {
  test("az + unauthorized + tenant → emits `az login --tenant <id>` copyable", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ lastTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47" }));
    expect(out.copyable).toBe("az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47");
    expect(out.text).toMatch(/Azure CLI/);
  });

  test("az + unauthorized + null tenant → emits bare `az login`", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ lastTenantId: null }));
    expect(out.copyable).toBe("az login");
  });

  test("Windows az.cmd absolute path is detected as az", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(
      ctx({ command: '"C:\\Program Files\\Azure CLI\\wbin\\az.cmd" account get-access-token --output json' }),
    );
    expect(out.copyable).toBe("az login");
  });

  test("custom command-based server falls through to DefaultRemediationFormatter (P2 guard)", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ command: "/usr/local/bin/my-helper.sh --emit-json" }));
    expect(out.copyable).toBe("");
    expect(out.text).toMatch(/Credentials rejected/);
  });

  test("null command falls through to default formatter", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ command: null }));
    expect(out.copyable).toBe("");
  });

  test("static-bearer variant falls through (variant guard)", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ variant: "static-bearer" }));
    expect(out.copyable).toBe("");
  });

  test("denied (403) error falls through — consent message not specialized", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(ctx({ error: { kind: "denied" } }));
    expect(out.copyable).toBe("");
    expect(out.text).toMatch(/denied access/);
  });

  test("timeout error with az command → specialized (FR-014)", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(
      ctx({
        error: { kind: "timeout" },
        lastTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      }),
    );
    expect(out.copyable).toBe("az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47");
    expect(out.text).toMatch(/Azure CLI/);
    expect(out.text).toMatch(/timed out/i);
  });

  test("command-failed error with az command → specialized (FR-014)", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(
      ctx({
        error: { kind: "command-failed", detail: "exit 1" },
        lastTenantId: null,
      }),
    );
    expect(out.copyable).toBe("az login");
    expect(out.text).toMatch(/Azure CLI/);
    expect(out.text).toMatch(/Sign in and retry/);
  });

  test("command-failed for non-az command still falls through to default", () => {
    const fmt = new M365RemediationFormatter();
    const out = fmt.format(
      ctx({
        command: "/usr/local/bin/my-helper.sh",
        error: { kind: "command-failed", detail: "exit 1" },
      }),
    );
    expect(out.copyable).toBe("");
  });

  test("custom fallback formatter is honored", () => {
    const customFallback = {
      format: () => ({ text: "custom-text", copyable: "custom-copy" }),
    };
    const fmt = new M365RemediationFormatter(customFallback);
    const out = fmt.format(ctx({ command: "my-helper" }));
    expect(out).toEqual({ text: "custom-text", copyable: "custom-copy" });
  });

  test("composed with DefaultRemediationFormatter retains detail propagation", () => {
    const fmt = new M365RemediationFormatter(new DefaultRemediationFormatter());
    const out = fmt.format(
      ctx({
        command: "my-helper",
        error: { kind: "command-failed", detail: "non-zero exit" },
      }),
    );
    expect(out.text).toContain("non-zero exit");
  });
});

describe("isAzExecutable", () => {
  test.each([
    ["az", true],
    ["AZ", true],
    ["az.cmd", true],
    ["AZ.CMD", true],
    ["az.bat", true],
    ["az.exe", true],
    ["C:\\Program Files\\Azure CLI\\wbin\\az.cmd", true],
    ["/usr/local/bin/az", true],
    ["my-az-wrapper", false],
    ["azz", false],
    ["az-cli", false],
    ["bash", false],
  ])("isAzExecutable(%j) = %j", (token, expected) => {
    expect(isAzExecutable(token)).toBe(expected);
  });
});
