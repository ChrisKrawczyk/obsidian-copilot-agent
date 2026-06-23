import { parseCommandLine } from "./argv";
import {
  DefaultRemediationFormatter,
  type RemediationContext,
  type RemediationFormatter,
  type Remediation,
} from "./RemediationFormatter";

/**
 * Specialization of `RemediationFormatter` that emits the `az login` hint
 * when the failing server is the M365 Graph preset (or any command-based
 * server whose first argv token resolves to `az`).
 *
 * Spec FR-014 + P2 user-story guard: arbitrary command-based servers (a
 * user-authored helper script) MUST NOT receive the `az login` hint. This
 * formatter only specializes when:
 *   - `error.kind` is one of `unauthorized`, `command-failed`, or `timeout`
 *     (FR-014: "When the credential command fails or times out… the hint
 *     SHALL be the `az login` command.")
 *   - `variant === "command-based"`
 *   - `command` is non-null AND its first argv token, after tokenization
 *     and case-insensitive basename match, is one of: `az`, `az.cmd`,
 *     `az.bat`, `az.exe`.
 *
 * All other paths delegate to a composed `DefaultRemediationFormatter` so
 * remediation text for non-az command-based errors and 403 (denied) errors
 * remain generic.
 */
export class M365RemediationFormatter implements RemediationFormatter {
  private readonly fallback: RemediationFormatter;

  constructor(fallback: RemediationFormatter = new DefaultRemediationFormatter()) {
    this.fallback = fallback;
  }

  format(ctx: RemediationContext): Remediation {
    if (this.shouldSpecialize(ctx)) {
      const tenant = ctx.lastTenantId;
      const copyable = tenant ? `az login --tenant ${tenant}` : "az login";
      const text = this.specializedText(ctx);
      return {
        text,
        copyable,
      };
    }
    return this.fallback.format(ctx);
  }

  /**
   * FR-014: M365 errors of kinds `unauthorized`, `command-failed`, and
   * `timeout` all surface the same `az login` remediation hint. The text
   * differs slightly so the user understands whether the token was rejected
   * by the server vs. the local CLI itself failed or hung.
   */
  private specializedText(ctx: RemediationContext): string {
    switch (ctx.error.kind) {
      case "unauthorized":
        return "Azure CLI credentials are not signed in or have expired. Sign in and retry.";
      case "timeout":
        return "Azure CLI credential command timed out. Sign in and retry.";
      case "command-failed":
      default: {
        const detail = ctx.error.detail ? ` Detail: ${ctx.error.detail}.` : "";
        return `Azure CLI credential command failed. Sign in and retry.${detail}`;
      }
    }
  }

  private shouldSpecialize(ctx: RemediationContext): boolean {
    if (ctx.variant !== "command-based") return false;
    if (
      ctx.error.kind !== "unauthorized" &&
      ctx.error.kind !== "command-failed" &&
      ctx.error.kind !== "timeout"
    ) {
      return false;
    }
    if (!ctx.command) return false;
    const argv = parseCommandLine(ctx.command);
    const first = argv[0];
    if (!first) return false;
    return isAzExecutable(first);
  }
}

/**
 * Case-insensitive match against `az`, `az.cmd`, `az.bat`, `az.exe`. Strips
 * any leading directory path so absolute paths like
 * `C:\Program Files\Azure CLI\wbin\az.cmd` resolve correctly.
 */
export function isAzExecutable(commandToken: string): boolean {
  const basename = commandToken.replace(/^.*[\\/]/, "").toLowerCase();
  return (
    basename === "az" ||
    basename === "az.cmd" ||
    basename === "az.bat" ||
    basename === "az.exe"
  );
}
