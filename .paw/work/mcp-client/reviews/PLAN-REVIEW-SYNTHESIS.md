# PLAN REVIEW SYNTHESIS

- Artifact: `.paw\work\mcp-client\ImplementationPlan.md`
- Review mode: multi-model + specialist perspectives
- Models: `gpt-5.4`, `gemini-3.1-pro-preview`, `claude-opus-4.7`
- Specialists: security/threat-modeling, operational-resilience
- Final verdict: **NEEDS-REVISION**

## Consensus Issues

### Consensus positives

- All model reviewers agreed the plan has complete section-level FR/NFR/SC traceability and no orphan FRs/SCs.
- All model reviewers agreed the high-level ordering is directionally correct: persistence/identity and safety gates precede runtime/tool execution.
- Real-code anchors are broadly correct. Existing anchors verified include `SafetyPolicy.ts`, `AgentSession.ts`, `ToolCallBlock.ts`, `PreambleAssembler.ts`, `SafetySettingsStore.ts`, `SettingsTab.ts`, `main.ts`, `PersistedShape.ts`, `MessageRenderer.ts`, and `lifecycle.ts`.
- Phase quality gates consistently include test/typecheck/build, and most FRs have named test hooks.

### Consensus or near-consensus gaps

1. **Phase 5/Phase 6 shippability boundary is risky.** Opus flagged Phase 5 as the heaviest phase and noted live MCP exposure lands before Phase 6 resilience. Operational resilience escalated this to MUST-FIX because Phase 5 ships live `tools/call` before cancellation, in-flight rejection, stale HTTP session retry, and `list_changed` coalescing land.
2. **NFR-005 bundle-size verification is under-specified.** GPT called this a consideration; Opus escalated it to MUST-FIX because the plan lacks a concrete gzip delta gate or waiver path in a phase quality gate.
3. **Migration/compatibility for existing `mcpAutoApprove` shape is under-specified.** Opus flagged missing handling for legacy `Record<string, boolean>` data and Phase 1 green-state risk.
4. **Redaction/logging call-site discipline needs clearer ownership.** GPT noted persisted status/last-error must use redaction-safe snapshots; security and resilience both requested a single logging/redaction seam and explicit SDK error/stack/diagnostic coverage.
5. **Tool identity parsing and trust scope must be fail-closed.** Security raised missing synthetic id parser/normalization rules and synchronous current trust-epoch lookup as MUST-FIX; these are central to FR-009/FR-012.

## Partial Agreement

- **Overall verdict:** GPT and Gemini returned PASS; Opus returned NEEDS-REVISION (minor); both specialists returned NEEDS-REVISION. The synthesis follows the stricter specialist findings because they identify security/resilience phase-shippability gaps.
- **Phase ordering:** Models praised the overall sequence, but operational resilience found that the Phase 5 → Phase 6 split violates the plan's own green-stopping invariant once end-to-end MCP execution is exposed.
- **HTTP security:** General model reviews considered URL/TLS/redirect controls covered; security found enforcement location ambiguous because config-time `httpPolicy.ts` alone does not guarantee SDK runtime redirect/header behavior.
- **Undo suppression:** General model reviews accepted no-Undo coverage; security found the existing `shouldRenderUndoButton` predicate does not take `source`, so the plan's defense-in-depth promise is not implementable as currently written.
- **Test adequacy:** All agreed coverage is strong, but Opus/security/resilience identified missing named tests for session-id round-trip, bundle-size measurement, hostile tool names, explicit env override warnings, initialization cancellation, corrupt config normalization, shutdown budget, and redaction error paths.

## Single-Model Insights

### `gpt-5.4`

- Verdict: **PASS**.
- Useful should-fix items:
  - Make FR-007 capability negotiation assertions explicit (`capabilities: {}` and `tools/list_changed` subscription behavior).
  - Name the owner/test for the one-shot grant-revocation notice.
  - Operationalize NFR-001 and NFR-005 checks.

### `gemini-3.1-pro-preview`

- Verdict: **PASS**.
- Found full requirement coverage, correct safety-first ordering, verified major anchors, and no findings.

### `claude-opus-4.7`

- Verdict: **NEEDS-REVISION (minor)**.
- MUST-FIX:
  - Add explicit bundle-size measurement/waiver gate for NFR-005/SC-005.
  - Specify `mcpAutoApprove` legacy shape handling and Phase 1 compatibility.
- SHOULD-FIX:
  - Add Phase 5 sub-checklist or split/annotate it as the largest phase.
  - Add named FR-019 `Mcp-Session-Id` round-trip test.
  - Name FR-029 protocol matrix fixture/test.
  - Clarify Phase 1 keeps current `decideSafety` MCP read path green until Phase 2 replacement.

## Specialist Findings

### Security / threat-modeling

Verdict: **NEEDS-REVISION**.

MUST-FIX findings:

1. Runtime HTTP redirect cap, per-hop URL classification, cross-origin `Authorization` stripping, and `Mcp-Session-Id` handling must be enforced inside the SDK transport path, not only in config-time `httpPolicy.ts`.
2. `ToolCallBlock.shouldRenderUndoButton` must suppress Undo by `source === "mcp"` even when `undoId` is mistakenly present.
3. Synthetic `mcp__<server-id>__<tool-name>` parser/normalization rules for hostile tool names are unspecified.
4. Explicit per-server `env` injection after denylist filtering can reintroduce secrets; Settings should warn and tests should cover denylist override keys.
5. Attacker-controlled stderr surfaced in Settings needs explicit control-character stripping and `textContent`/`<pre>` rendering contract.
6. Trust-epoch lookup must happen synchronously at decision time and fail closed on missing/mismatched epoch or removed server.
7. SDK stdio spawn behavior and Windows shell semantics must be owned/pinned/tested; exact-pin `@modelcontextprotocol/sdk@1.29.0` until covered.
8. Redaction must cover SDK-thrown errors, stack traces, `lastError`, stderr, console, and Notice paths.

Key should-fix items:

- Document prompt-injection posture for server instructions/tool descriptions.
- Echo DNS-rebinding deferral in "What We're NOT Doing".
- Negative-test absence of TLS verification bypass options.
- Bound `notifications/cancelled` payload to request id/reason only.
- Use one truncation helper/constant across approval, preamble, and rendered args.
- Clear approval short-circuit cache on MCP epoch rotation.

### Operational resilience

Verdict: **NEEDS-REVISION**.

MUST-FIX findings:

1. Phase 5 exposes live MCP execution before minimum resilience semantics land in Phase 6; either move minimum resilience into Phase 5 or mark Phase 5 as not independently end-user shippable.
2. Unload shutdown budget and parallelism are unspecified; per-server shutdown must be parallel/bounded and covered by quality gates.
3. Corrupt/malformed persisted `mcpServers` handling is unspecified; Phase 1 needs fail-closed normalization and tests.
4. Cancellation must not send MCP `notifications/cancelled` for `initialize`; Stop during initialize/discovery needs defined local teardown behavior and tests.

Key should-fix items:

- Pull disable/remove in-flight rejection earlier or document sequencing.
- Define Phase 5 interim `list_changed` behavior.
- Add Settings subscription cleanup/dispose tests.
- Ensure manual reconnect cancels armed backoff timers.
- Standardize MCP logging namespace/redaction seam.
- Reject/settle in-flight calls before unload shutdown ladder, not after a long tools/call timeout.

## Priority Actions

### Must-fix before implementation

1. **Resolve Phase 5/6 shippability.** Move minimum viable resilience into Phase 5 or explicitly declare Phase 5 not a clean end-user stopping point, with updated gates and rationale.
2. **Add concrete NFR-005 gate.** Record gzip bundle delta when SDK lands and require ≤80 KB or documented waiver.
3. **Specify legacy/corrupt persistence handling.** Cover legacy `mcpAutoApprove`, malformed `mcpServers`, sibling-key preservation, and fail-closed defaults.
4. **Harden MCP identity and trust.** Define server id/tool name normalization, parser rules, grant-key source of truth, current trust-epoch lookup, and fail-closed removed/disabled behavior.
5. **Pin/enforce transport security.** Document SDK HTTP custom fetch/redirect/header enforcement and stdio spawn ownership with Windows tests and exact SDK pin.
6. **Make no-Undo source-keyed.** Plan the `ToolCallBlock` predicate change and test `source: "mcp"` plus `undoId`.
7. **Define redaction/rendering seams.** Enumerate all redacted write/display paths and safe-render stderr/last-error behavior.
8. **Bound lifecycle/cancellation.** Define unload aggregate cap/parallelism, in-flight waiter settlement, initialize cancellation exception, and Stop during discovery.

### Should-fix before implementation

1. Add explicit FR-007 capability negotiation assertions.
2. Add named FR-019 session-id round-trip/drop-on-reload test.
3. Add explicit FR-029 protocol matrix fixture/test.
4. Assign owner/test for one-shot trust-epoch grant-revocation notice.
5. Add explicit env override warning/test cases for denylisted keys.
6. Add Settings subscription cleanup tests and manual reconnect timer-cancel tests.
7. Document Phase 5 sub-checklist or split plan to control sizing.
8. Add prompt-injection, DNS-rebinding deferral, and TLS-bypass-negative-test notes.

### Consider

1. Add Windows `.cmd`/`npx` Settings hint.
2. Document HTTP DELETE deferral/interim behavior before Phase 6.
3. Use a separate `mcpToolNames` set rather than reusing `customToolNames`.
4. Add aggregate discovery wall-clock cap across paginated `tools/list`.
5. Add cross-store `data.json` write coordination tests.
6. Add user-visible stable-id/display-name/trust-fingerprint hints.
7. Add a dedicated MCP logger (`McpLogger`) and prohibit direct `console.*` inside `src\mcp\`.

## Final Verdict

**NEEDS-REVISION**

The plan is strong, well-structured, and broadly complete, but the combined security and operational findings identify several issues that affect phase shippability and fail-closed safety. Revise the plan to address the must-fix actions above; no implementation should start until the Phase 5/6 boundary, transport enforcement, persistence normalization, trust identity, redaction, and lifecycle/cancellation gates are made explicit.
