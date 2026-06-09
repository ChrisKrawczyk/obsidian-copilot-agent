import type { PermissionRequest } from "./types";

/**
 * Phase 2 ships a single decision shape: deny-by-default. Phase 6 swaps in
 * the SafetyPolicy decision function, which will return richer kinds
 * (approve-once, approve-for-session, etc.).
 */
export type DecisionKind = "approve-once" | "approve-for-session" | "reject";

export interface PermissionDecision {
  kind: DecisionKind;
  /** Surfaced to the model on rejection so it can narrate the denial. */
  feedback?: string;
}

export type PermissionDecider = (
  request: PermissionRequest,
) => Promise<PermissionDecision> | PermissionDecision;

/**
 * Phase 2 universal-approval-gate stub. Denies every tool invocation and
 * returns a feedback string the model can incorporate into its response.
 */
export const denyAll: PermissionDecider = (request) => ({
  kind: "reject",
  feedback:
    `Tool execution is disabled in this build (Phase 2 deny-by-default policy). ` +
    `Requested tool: ${request.toolName ?? request.kind}. ` +
    `Please answer the user without invoking tools.`,
});
