# Spec Review — v0.5 MCP Client Integration

- **Model:** gpt-5.4
- **Verdict:** NEEDS-REVISION
- **Checklist pass count (approx.):** 12 / 23
- **Issues found:** 7

## Summary

The artifact is strong on detailed FR coverage, traceability, and explicit MCP protocol decisions, and the requested integration anchors mostly do exist in `src`. However, it is not yet ready as a planning-ready spec because it regresses the v0.4 spec structure (no user stories / acceptance scenarios / assumptions / risks), contains at least one protocol-fact mismatch around `2024-11-05` HTTP compatibility, and includes success criteria that are not human-verifiable as written.

## Findings

### 1) Missing user-story layer and FR-to-story mapping
- **Severity:** must-fix
- **Affected sections/IDs:** Whole artifact structure; FR-001..FR-026; SC-001..SC-010
- **Evidence:** `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\Spec.md:3-241` contains Summary, Goals, Non-Goals, FRs, NFRs, SCs, Traceability, Migration, Open Questions, and Citations, but no User Stories, Edge Cases, Assumptions, Scope, or Risks sections. The v0.4 anchor includes those sections at `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\Spec.md:30,164,175,184,215`.
- **Suggested direction:** Restore a user-story section with explicit priorities and Given/When/Then scenarios, then map each FR back to one or more stories. Keep the anchor/protocol appendix if needed, but do not skip the user-facing story scaffold.

### 2) `2024-11-05` HTTP compatibility is not aligned with the research record
- **Severity:** must-fix
- **Affected sections/IDs:** Summary; FR-005; FR-006; NFR-004
- **Evidence:** The spec locks “accept `2024-11-05` only over stdio or Streamable HTTP” and says `2024-11-05` works over Streamable HTTP (`Spec.md:9,55-63,170`). But the research states Streamable HTTP replaced deprecated HTTP+SSE, and legacy fallback is a separate open question (`SpecResearch.md:309-367,887-895`).
- **Suggested direction:** Clarify whether `2024-11-05` compatibility is stdio-only, or whether HTTP compatibility requires explicit legacy SSE fallback. As written, the spec promises an HTTP compatibility mode the research does not substantiate.

### 3) SC-007 and SC-008 are not human-verifiable as written
- **Severity:** must-fix
- **Affected sections/IDs:** SC-007; SC-008; FR-022; FR-024
- **Evidence:** `Spec.md:184-185` requires observing subprocess env filtering and the exact stdin-close → SIGTERM → SIGKILL sequence. Those are harness/internal-process assertions, not normal human-observable product outcomes.
- **Suggested direction:** Recast these SCs into user-visible/manual outcomes (for example, diagnostic visibility or observable cleanup behavior), and keep the low-level env/signal assertions in traceability/test-surface notes.

### 4) Bundle-size NFR is inconsistent with the research estimate
- **Severity:** should-fix
- **Affected sections/IDs:** NFR-005
- **Evidence:** The spec sets a target of “≤ 80 KB gzip” for MCP SDK client paths (`Spec.md:171-172`), while the research estimates roughly `~300–600 KB` bundle contribution after tree-shaking (`SpecResearch.md:483-485`).
- **Suggested direction:** Replace the 80 KB figure with a measured baseline gate, percentage budget, or an explicit “document and justify actual delta” rule. The current target looks unattainable from the cited research.

### 5) Allowlist scope is narrower than WorkflowContext
- **Severity:** should-fix
- **Affected sections/IDs:** Goals; FR-012
- **Evidence:** WorkflowContext says approval can be bypassed only if the user explicitly auto-approves “a specific server or tool” (`WorkflowContext.md:42-46`). The spec narrows this to server-only semantics via `mcpAutoApprove[serverName]` and session grant-by-server (`Spec.md:16,90-93`). The current code anchors are also server-keyed: `C:\Repos\obsidian-copilot-agent\src\domain\SafetyPolicy.ts:48-49,74-90,199-215`.
- **Suggested direction:** Either explicitly document v0.5 as server-only and call out the scope reduction from WorkflowContext, or add per-tool semantics to match the workflow goal.

### 6) One integration anchor is named inaccurately
- **Severity:** should-fix
- **Affected sections/IDs:** Goals; FR-011
- **Evidence:** The spec cites `SafetyPolicy.decideSafety` (`Spec.md:16,87`), but the code exports a top-level `decideSafety` function from `C:\Repos\obsidian-copilot-agent\src\domain\SafetyPolicy.ts:146`. Confirmed adjacent anchors do exist: `SafetySource = "mcp"` (`:19`), `mcpAutoApprove` (`:49`), `SafetyState.grantMcp` (`:74-76`), `AgentSession.buildSafetyInput` (`C:\Repos\obsidian-copilot-agent\src\sdk\AgentSession.ts:1610-1642`), and `ToolCallBlock` module/rendering (`C:\Repos\obsidian-copilot-agent\src\ui\ToolCallBlock.ts:45-54,79-180`).
- **Suggested direction:** Normalize anchor references to actual exported symbol/module names so the spec remains reliable as an integration guide.

### 7) Timeout policy from research is not carried into the spec
- **Severity:** should-fix
- **Affected sections/IDs:** FR-021; NFR-002
- **Evidence:** The research calls out timeout handling as an explicit client policy choice and recommends locking it in the spec (`SpecResearch.md:822-839`). The current spec covers Stop/cancellation but does not define any MCP request timeout or maximum wait behavior (`Spec.md:135-138,168-169`).
- **Suggested direction:** Add a requirement or assumption for timeout posture (even if the exact number is configurable) so hung servers are covered by observable behavior, not just manual Stop.

## Positives / Confirmed Anchors

- The requested safety/integration anchors are mostly real and well-placed in the current codebase:
  - `SafetySource = "mcp"` — `C:\Repos\obsidian-copilot-agent\src\domain\SafetyPolicy.ts:19`
  - `mcpAutoApprove` — `...\SafetyPolicy.ts:49,210`
  - `SafetyState` / `grantMcp()` — `...\SafetyPolicy.ts:61-101`
  - `AgentSession.buildSafetyInput()` mapping `kind === "mcp"` to `source: "mcp"` — `C:\Repos\obsidian-copilot-agent\src\sdk\AgentSession.ts:1610-1642`
  - `ToolCallBlock` render/Undo surface with MCP source labeling hooks — `C:\Repos\obsidian-copilot-agent\src\ui\ToolCallBlock.ts:45-54,79-180,274-292`
- Every FR has acceptance criteria, and the traceability table is unusually thorough (`Spec.md:189-226`).
- Out-of-scope coverage is largely aligned with WorkflowContext on no server mode, no OAuth flow, no resources/prompts/sampling, no registry browsing, and no telemetry (`WorkflowContext.md:59-68`; `Spec.md:21-31`).

## Overall Assessment

Good technical depth, but the artifact still needs structural spec work plus a few research/constraint corrections before it is planning-ready.
