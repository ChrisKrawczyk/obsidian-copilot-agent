# PAW Spec Review: MCP Client Integration (v0.5)

**Model:** Gemini 3.1 Pro Preview
**Verdict:** PASS
**Pass Count:** 26/26 FRs, 8/8 NFRs, 10/10 SCs

## Summary
The v0.5 MCP Client spec is robust, exceptionally well-researched, and aligns perfectly with the MCP `2025-06-18` protocol requirements (including Streamable HTTP, pagination, and the JSON-RPC lifecycle). Furthermore, the codebase anchor integration points referenced in the spec (such as `SafetySource = "mcp"`, `mcpAutoApprove`, `SafetyState.grantMcp`, and `AgentSession.buildSafetyInput`) were independently verified against the `src` directory and map accurately to existing wiring. The choice to strictly filter environment variables and gracefully handle `ToolCallBlock` undo suppression demonstrates excellent attention to architectural continuity and system safety.

## Positive Findings (Anchors Verified)
- **Verified Codebase Anchors:** `SafetySource` in `SafetyPolicy.ts` natively supports `"mcp"`. `SafetyState` correctly includes `grantMcp()`. `AgentSession.buildSafetyInput` already implements `kind === "mcp"` mapping the server name to the `toolName` parameter, and `ToolCallBlock` correctly accepts `isUndoSuppressed`. The integration plan effectively leverages pre-existing infrastructure.
- **Protocol Fidelity:** The spec correctly adopts Streamable HTTP and actively discards the deprecated HTTP+SSE transport (FR-005), standardizes the `2025-06-18` protocol version handshake (FR-006), and accurately reflects transport-specific shutdown mechanics, including the 5s SIGTERM/SIGKILL escalation (FR-024).
- **Graceful Degradation:** FR-026 and SC-004 properly account for the no-MCP baseline, preserving the v0.4 model picker, token rotation, and other constraints mandated by the WorkflowContext. NFR-005 also includes an excellent bundle size sanity check for the SDK client integration.

## Findings

### Consider: Explicitly document the UX tradeoff for `npx` on Windows
- **Severity:** consider
- **Affected IDs:** FR-004
- **Evidence:** `SpecResearch.md` §2a points out that `npx` requires `cmd /c` on Windows and suggests "The plugin SHOULD use `cmd /c` wrapper... or handle via a path-resolution helper." FR-004 opts for the manual route: "Windows users can configure `cmd /c npx ...`".
- **Direction:** Given WorkflowContext Goal 3 restricts v0.5 to manual JSON-style entry only, expecting Windows users to input `cmd /c` is an acceptable constraint. However, consider making sure this is explicitly documented in user-facing setup instructions (e.g. `Docs.md`) to prevent configuration friction.

### Consider: Clean up outdated Phase terminology in SafetyPolicy comments
- **Severity:** consider
- **Affected IDs:** FR-011, FR-012
- **Evidence:** `src\domain\SafetyPolicy.ts` line 48 reads: `/* Per-MCP-server auto-approve toggles keyed by server name. Reserved for Phase 8; honoured here for forward compat. */`
- **Direction:** While the spec correctly leverages `mcpAutoApprove`, the source codebase's comments refer to this work as "Phase 8". Consider updating this comment as part of the implementation PR to reflect the current v0.5 release.

## Conclusion
The spec satisfies all WorkflowContext goals, introduces no scope creep, natively respects the safety permission gates, and grounds its requirements in hard facts from the MCP specification. It is fully ready for the implementation phase.