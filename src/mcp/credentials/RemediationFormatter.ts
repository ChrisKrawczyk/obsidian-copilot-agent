import type { ServerCredentials } from "./CredentialTypes";

export type RemediationErrorKind =
  | "command-failed"
  | "unauthorized"
  | "denied"
  | "timeout";

export interface RemediationContext {
  variant: ServerCredentials["kind"];
  /** Configured command-based command string (or `null` for other variants). */
  command: string | null;
  /** Last-known tenant id retained across `invalidate()` (or `null`). */
  lastTenantId: string | null;
  error: { kind: RemediationErrorKind; detail?: string };
}

export interface Remediation {
  /** Human-readable hint for chat / settings rows. */
  text: string;
  /** Optional verbatim command the user can copy + run to remediate. */
  copyable: string;
}

export interface RemediationFormatter {
  format(ctx: RemediationContext): Remediation;
}

/**
 * Generic, command-agnostic remediation hints. Per the plan, the default
 * formatter MUST NOT emit `az login` for arbitrary command-based variants
 * — that specialization belongs to `M365RemediationFormatter` (Phase 5),
 * which inspects `command` to decide whether the M365 hint applies.
 */
export class DefaultRemediationFormatter implements RemediationFormatter {
  format(ctx: RemediationContext): Remediation {
    const { variant, error } = ctx;
    const detail = error.detail ? ` Detail: ${error.detail}.` : "";
    switch (error.kind) {
      case "unauthorized":
        return {
          text:
            (variant === "static-bearer"
              ? "Credentials rejected. Replace the configured bearer token and retry."
              : variant === "command-based"
                ? "Credentials rejected. Re-run your credential command, ensure it emits a valid JSON token, then retry."
                : "Credentials rejected by the server.") + detail,
          copyable: "",
        };
      case "denied":
        return {
          text:
            "Server denied access — confirm the signed-in identity has consented to the required scopes. " +
            "See docs/m365-graph-mcp.md for guidance." + detail,
          copyable: "",
        };
      case "timeout":
        return {
          text:
            (variant === "command-based"
              ? "Credential command timed out. Verify the command runs interactively and emits JSON within the timeout."
              : "Credential resolution timed out.") + detail,
          copyable: "",
        };
      case "command-failed":
        return {
          text:
            "Credential command failed. Ensure it is signed in and emits valid JSON." + detail,
          copyable: "",
        };
    }
  }
}
