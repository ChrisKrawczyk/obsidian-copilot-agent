# Spec Review — v0.5 MCP Client Integration

- **Reviewer model:** claude-opus-4.7 (PAW spec-review, independent reviewer 1 of 3)
- **Artifact reviewed:** `.paw/work/mcp-client/Spec.md`
- **Supporting inputs:** `SpecResearch.md`, `WorkflowContext.md`, v0.4 `model-picker/Spec.md` (style anchor), live `src/` tree.
- **Verdict:** **NEEDS-REVISION** (blocking only on a small set of clarity should-fix items; no must-fix found).
- **Quality criteria estimate:** ~22/26 paw-spec-review checklist items pass cleanly; ~4 are weak (ambiguity / missing structural sections from the documented v0.4 style anchor).

---

## Verified positives (codebase anchors and protocol facts)

All integration anchors named in Spec.md are real, exactly as written:

- `SafetySource = "vault" | "extra-vault" | "mcp" | "builtin"` — `src\domain\SafetyPolicy.ts:19`.
- `mcpAutoApprove?: Record<string, boolean>` field on `SafetyConfig` — `src\domain\SafetyPolicy.ts:49`.
- `class SafetyState` with `grantMcp(serverName)` and `isMcpGranted` — `src\domain\SafetyPolicy.ts:61, 74, 88`.
- `decideSafety(...)` honoring `mcpAutoApprove[serverName]` — `src\domain\SafetyPolicy.ts:146, 210`.
- `AgentSession.buildSafetyInput` mapping `kind === "mcp"` to `{ source: "mcp", toolName: request.serverName ?? toolName ?? "(unknown)" }` — `src\sdk\AgentSession.ts:1610, 1630–1635`.
- Tool-call source threading already accepts `"mcp"` — `src\sdk\AgentSession.ts:31, 687, 706, 1722, 1728`.
- `ToolCallBlock` exposes a per-call Undo-suppression hook (`isUndoSuppressed`) and `shouldRenderUndoButton` — `src\ui\ToolCallBlock.ts:37, 45–53, 119–139`. The MCP `kind` is already plumbed in render switches at `src\ui\ToolCallBlock.ts:278, 291`.
- Persistence layer present (`src\persistence\PersistedShape.ts`, `migrate.ts`, `ConversationsStore.ts`) — supports the additive `data.json` story in FR-001.
- Test files referenced exist: `src\sdk\AgentSession.test.ts`, `src\domain\SafetyPolicy.test.ts`, `src\ui\ToolCallBlock.test.ts`, `src\persistence\migrate.test.ts`.

Protocol facts in FR-006/007/008/019/020/024 are consistent with `SpecResearch.md` §1.1, §1.2, §1.3, §1.4, §2a, §2b, §7, §9 (latest spec version `2025-06-18`, newline-delimited stdio JSON-RPC, Streamable HTTP single endpoint, `Mcp-Session-Id` non-persistence, HTTP DELETE w/ 405 tolerance, stdin→SIGTERM→SIGKILL stdio shutdown).

WorkflowContext goals (lines 36–58) and out-of-scope items (lines 59–68) are mirrored cleanly in Spec.md "Goals" and "Non-Goals" — including the matching deferrals: be-an-MCP-server, OAuth, resources/prompts, sampling, registry, mid-stream live refresh, per-conversation allowlist, telemetry, Undo for MCP.

---

## Findings

### Should-fix

#### 1. Structural deviation from v0.4 style anchor (User Stories / Edge Cases / Risks / Assumptions / Problem Statement absent)
- **Severity:** should-fix
- **Affected:** Spec.md document structure
- **Evidence:** v0.4 anchor `.paw\work\model-picker\Spec.md` §§Overview, Objectives, Problem Statement, User Stories, Functional Requirements, Non-Functional Requirements, Success Criteria, Edge Cases, Assumptions, Scope, Risks, Traceability, Revision Notes (`grep -n "^##"` in that file). The MCP Spec.md uses Summary / Goals / Non-Goals / FR / NFR / SC / Traceability / Migration / Open Questions / Citations — dropping User Stories, Problem Statement, Edge Cases, Assumptions, Risks. WorkflowContext explicitly names the v0.4 spec as the style anchor.
- **Suggested direction:** Either add the missing top-level sections (even if short) so future readers and the planning step can hang risks/edge-cases off them, or document the intentional structural deviation in the Citations / Revision Notes.

#### 2. FR-006 — "Accept `2024-11-05` over Streamable HTTP" interaction is under-specified
- **Severity:** should-fix
- **Affected:** FR-006 (Spec.md:60–63), Summary (Spec.md:9)
- **Evidence:** Per `SpecResearch.md` §2b, the `2024-11-05` protocol version was historically tied to the deprecated **HTTP+SSE** transport, and §1.1 notes version negotiation says "client SHOULD disconnect if it cannot handle the server's version." Spec.md says we "MUST NOT fall back to deprecated HTTP+SSE" (FR-005) yet "accept `2024-11-05` only over stdio or Streamable HTTP" (FR-006 + Summary). It is therefore ambiguous whether a server that *advertises* `2024-11-05` but *speaks* Streamable HTTP semantics is acceptable, vs. one that expects HTTP+SSE framing.
- **Suggested direction:** Pin the rule to transport behavior, not the version string alone — e.g., make explicit that `2024-11-05` is accepted iff the server actually speaks the supported framing (stdio newline JSON-RPC or Streamable HTTP single-endpoint) and is rejected with the same "unsupported transport" error path as legacy-SSE-only endpoints (FR-005).

#### 3. FR-008 — "rejected OR de-duplicated" leaves contradictory user-visible behavior
- **Severity:** should-fix
- **Affected:** FR-008 (Spec.md:71–73)
- **Evidence:** Acceptance reads "duplicate tool names within a server are rejected or deterministically de-duplicated with visible error." Two implementations could ship and both pass the FR, but the user experience differs (zero tools vs. partial tools).
- **Suggested direction:** Pick one behavior (preferred: reject the offending pair / mark inventory as malformed with a clear last-error) so the test surface and SC are deterministic.

#### 4. FR-018 — Auto-reconnect "bound" is not quantified
- **Severity:** should-fix
- **Affected:** FR-018 (Spec.md:120–123)
- **Evidence:** "MUST attempt bounded exponential-backoff" — but no max-delay or max-attempt cap is given. Without a bound, "fake-timer reconnect tests" cannot assert termination.
- **Suggested direction:** Specify either a max attempt count, a max backoff ceiling, or both (e.g., backoff capped at N seconds, or "stops after M failures and waits for manual reconnect"). Compare with the v0.4 deferred-init recovery cap if there is one in the codebase.

#### 5. FR-022 — Env-denylist contents are partially hand-waved
- **Severity:** should-fix
- **Affected:** FR-022 (Spec.md:140–143)
- **Evidence:** "plugin-owned auth/session env keys **such as** any process-env representation of the in-memory GitHub token or `COPILOT_HOME`/base-directory state" — the "such as" hedge makes the test surface ambiguous, especially given the in-memory GitHub token may not normally be on `process.env` at all (per `SpecResearch.md` §5.1 which only flags ambient `GITHUB_TOKEN`-style risk).
- **Suggested direction:** Enumerate the exact denied keys/prefixes (e.g., `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `COPILOT_*`, `COPILOT_AGENT_*`, `OPENAI_*`, `ANTHROPIC_*`, plus any plugin-owned process-env names actually used) and move "anything that may carry plugin-owned secrets" to a non-binding rationale note.

#### 6. FR-025 — "HTTP is allowed only for localhost/loopback OR requires explicit warning" is a polysemous "or"
- **Severity:** should-fix
- **Affected:** FR-025 (Spec.md:155–158)
- **Evidence:** The acceptance phrasing is ambiguous between (a) localhost is auto-allowed and non-localhost HTTP requires confirmation, vs. (b) implementations may choose either policy. SC-002 only exercises HTTPS so neither branch is verified by SCs.
- **Suggested direction:** State a single policy — e.g., "non-loopback `http://` URLs are rejected by default and require an explicit per-server `allowInsecureHttp` config the user must toggle, with a UI warning."

#### 7. NFR-005 — Bundle-size NFR carries an open-ended escape hatch
- **Severity:** should-fix
- **Affected:** NFR-005 (Spec.md:171)
- **Evidence:** "≤ 80 KB gzip … **or** the implementation documents why and verifies server-side SDK paths were tree-shaken." A "document why" exit converts the NFR from a hard test (`bundle-size build check` per the traceability table) into a waiver. SC coverage is also indirect (SC-004 covers baseline behavior, not size).
- **Suggested direction:** Either keep the threshold as a hard fail and drop the prose escape hatch, or restate as a tracked metric with a documented waiver process and remove the "Bundle-size build check" from the test surface.

### Consider (non-blocking)

#### 8. FR-009 — Cross-server tool-name collision policy not pinned
- **Severity:** consider
- **Affected:** FR-009 (Spec.md:75–78)
- **Evidence:** "Registered tool identity is globally unambiguous and preserves server attribution" — but the namespacing scheme (e.g., `mcp:<server>/<tool>`) is left abstract. The plan/implementation will have to make this decision; pinning it in spec helps the SDK tool list and approval-prompt UX stay consistent.
- **Suggested direction:** State the identity shape (or an equivalence rule) at FR-009 so prompt copy and `availableTools` glob (`AgentSession.ts:1064` etc.) are predictable.

#### 9. FR-013 — Mechanism for suppressing Undo on MCP calls is left implicit
- **Severity:** consider
- **Affected:** FR-013 (Spec.md:96–98)
- **Evidence:** `ToolCallBlock` already exposes `isUndoSuppressed?(toolName)` and gates Undo on `call.undoId` (`src\ui\ToolCallBlock.ts:37, 45–53`). FR-013 says only "suppress the Undo button"; there are at least two valid mechanisms (don't emit `undoId` at all vs. add MCP entries to `isUndoSuppressed`). This is a planning choice but worth a steer.
- **Suggested direction:** Note the preferred mechanism so FR-013 acceptance and the existing `ToolCallBlock` test surface align (e.g., "MCP tool calls MUST NOT be assigned an `undoId`").

#### 10. FR-015 — Placeholder format is "such as" (illustrative, not normative)
- **Severity:** consider
- **Affected:** FR-015 (Spec.md:106–108)
- **Evidence:** "MUST render as a placeholder **such as** `[image: <mime>, N bytes]`" + "Byte count is computed from decoded base64 **where possible**." The fallback when byte count cannot be computed (e.g., truncated/garbled base64) is unspecified.
- **Suggested direction:** Lock a single placeholder format and a fallback string (e.g., `[image: <mime>, size unknown]`) so SC-009 is deterministic.

#### 11. FR-021 — Cancellation is "SHOULD send" rather than MUST
- **Severity:** consider
- **Affected:** FR-021 (Spec.md:135–138)
- **Evidence:** Per `SpecResearch.md` §1.3 cancellation is best-effort, so SHOULD is defensible. The acceptance criteria already cover the conditional "when request id support exists" branch, which is the right hedge.
- **Suggested direction:** Either keep SHOULD and explicitly note the spec rationale in the FR rationale (helps reviewers) or upgrade to MUST and rely on the existing branch for the no-known-request case.

#### 12. FR-002 vs. WorkflowContext "manual JSON-style entry only"
- **Severity:** consider
- **Affected:** FR-002 (Spec.md:40–43), WorkflowContext §3
- **Evidence:** WorkflowContext line 44 says "manual JSON-style entry only" while FR-002 describes form-based add/edit/remove in Settings. The intent is plausibly "form fields whose schema mirrors a JSON config object" (which is fine), but it would be worth disambiguating to avoid a planner expecting a JSON textarea.
- **Suggested direction:** A short sentence in Goals or FR-002 clarifying "form-based fields, no live registry browsing" reconciles the two.

#### 13. NFR-001 / NFR-006 — Acceptance is qualitative
- **Severity:** consider
- **Affected:** NFR-001 (Spec.md:167), NFR-006 (Spec.md:172)
- **Evidence:** "Typical server" and "never blocks chat UI" / "keyboard-navigable with meaningful labels" are not anchored to a measurement protocol or a checklist.
- **Suggested direction:** Define "typical" (e.g., reference servers in `SpecResearch.md` §4) and reference an existing accessibility checklist if one is used in the v0.4 baseline.

#### 14. SC-006 — Wording is good; SC-002 less so
- **Severity:** consider (positive on SC-006, minor on SC-002)
- **Affected:** SC-002 (Spec.md:179), SC-006 (Spec.md:183)
- **Evidence:** SC-006 quantifies (3 notifications, 1 refresh) — a clean human-verifiable criterion. SC-002 says "observes negotiated protocol/session headers during that plugin load," which requires devtools/network capture and is not obvious to a non-implementer reviewer.
- **Suggested direction:** For SC-002, mention how a human verifies the headers (e.g., "via the plugin's status panel or DevTools network capture").

---

## Summary

The spec is technically sound, well-grounded in `SpecResearch.md`, and every codebase anchor it names is real and accurately described. The locked v0.5 decisions (protocol versions, transports, env policy, shutdown sequence, list-changed coalescing, no HTTP+SSE) collapse the ten open questions cleanly.

The reasons for **NEEDS-REVISION** rather than PASS are clarity items, not factual errors: the spec drops several structural sections present in the v0.4 style anchor (User Stories, Edge Cases, Risks, Assumptions, Problem Statement), and a handful of FRs/NFRs (FR-006, FR-008, FR-018, FR-022, FR-025, NFR-005) are phrased with "or" / "such as" / "bounded" / open escape hatches that leave the test surface non-deterministic. Tightening those before the planning step will pay back during plan and review.

No must-fix or BLOCKED issues. Once the should-fix items are addressed, the spec is plan-ready.

**Output written to:** `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\reviews\SPEC-REVIEW-claude-opus-4.7.md`
