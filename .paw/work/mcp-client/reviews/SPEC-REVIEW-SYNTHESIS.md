# SPEC-REVIEW-SYNTHESIS — v0.5 MCP Client Integration

- **Review mode:** multi-model, parallel
- **Models:** gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
- **Specialist perspectives:** security/threat-modeling, operational-resilience
- **Artifact reviewed:** `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\Spec.md`
- **Synthesis verdict:** **NEEDS-REVISION**

## Consensus Issues

### 1. Request/handshake timeout and bounded I/O are missing or under-specified
- **Priority:** must-fix
- **Seen by:** gpt-5.4, security specialist, operational-resilience specialist; related concern in claude-opus-4.7.
- **Affected:** FR-004, FR-008, FR-014, FR-021, NFR-002; likely needs one dedicated FR/SC.
- **Rationale:** SpecResearch calls out timeout policy as a client responsibility, but the spec only covers user Stop/cancellation. Security and resilience reviewers also identified missing caps on JSON-RPC line/frame size, HTTP body size, stderr buffers, tool-list pagination/page count, and `tools/call` duration.
- **Direction:** Add explicit, testable defaults/bounds and behavior on timeout/overflow: synthesize failure, reject in-flight work, preserve UI responsiveness, and avoid OOM/hang failure modes.

### 2. Auto-reconnect and failure recovery are not deterministic enough
- **Priority:** must-fix
- **Seen by:** claude-opus-4.7, gpt-5.4, security specialist, operational-resilience specialist.
- **Affected:** FR-018, SC-005.
- **Rationale:** “Bounded exponential-backoff” lacks base delay, cap, max attempts or wall-clock budget, jitter/reset rules, and terminal crashloop state. This leaves tests and user-visible behavior ambiguous.
- **Direction:** Pin retry schedule, reset-on-success behavior, crashloop terminal state, and matching human-verifiable SC.

### 3. Tool identity and collision semantics need a concrete model
- **Priority:** must-fix
- **Seen by:** security specialist, operational-resilience specialist; also considered by claude-opus-4.7.
- **Affected:** FR-008, FR-009, FR-010, FR-011/FR-012 safety prompts.
- **Rationale:** The spec says tool identity is globally unambiguous but does not define the SDK registration key or naming surface. Cross-server and built-in collisions, source spoofing, and refresh atomicity remain open.
- **Direction:** Specify namespacing/registration shape, cross-server duplicate behavior, server-name normalization/collision rules, and atomic inventory refresh behavior.

### 4. Security-sensitive wording is too permissive or ambiguous
- **Priority:** must-fix
- **Seen by:** security specialist; overlaps with claude-opus-4.7 and gpt-5.4 on FR-022/FR-025.
- **Affected:** FR-004, FR-022, FR-025, FR-019.
- **Rationale:** Spawn must explicitly forbid shell interpolation; env filtering must enumerate known cloud/AI secrets; HTTP transport must cover SSRF/private-IP/metadata-host classification; redirects must not leak Authorization; session IDs must be redacted from UI/log/error surfaces.
- **Direction:** Add small, testable acceptance criteria rather than relying on implementation intent.

## Partial Agreement

### 1. Spec structure vs v0.4 style anchor
- **Priority:** should-fix
- **Agreement:** gpt-5.4 marked missing User Stories/Edge Cases/Assumptions/Risks as must-fix; claude-opus-4.7 marked it should-fix; Gemini did not flag it.
- **Synthesis:** Treat as **should-fix** unless PAW workflow explicitly accepts this technical-spec structure. The missing sections reduce traceability to user value and risk mitigation, especially for a security-sensitive feature.

### 2. `2024-11-05` over Streamable HTTP compatibility
- **Priority:** should-fix
- **Agreement:** gpt-5.4 called this a protocol mismatch; claude-opus-4.7 called it under-specified; Gemini considered protocol fidelity acceptable.
- **Synthesis:** Treat as **should-fix**: clarify whether `2024-11-05` is accepted only when the server actually speaks supported stdio/Streamable HTTP framing, and reject legacy HTTP+SSE-only behavior.

### 3. SC human-verifiability
- **Priority:** should-fix
- **Agreement:** gpt-5.4 flagged SC-007/SC-008 as not human-verifiable; claude-opus-4.7 flagged SC-002 and qualitative NFRs; resilience flagged the need for more failure-mode SCs.
- **Synthesis:** Make SCs observable by a human or explicitly state required verification mechanism (UI status, DevTools/network capture, diagnostics panel, process test harness).

### 4. Bundle-size NFR
- **Priority:** should-fix
- **Agreement:** gpt-5.4 flagged conflict with research estimate; claude-opus-4.7 flagged the waiver/escape hatch; Gemini viewed it positively.
- **Synthesis:** Convert NFR-005 to a measurable gate based on actual bundle delta or a documented waiver process; avoid an unattainable hard number contradicted by research.

## Single-Model Insights

### gpt-5.4
- Identified `SafetyPolicy.decideSafety` as an inaccurate anchor name: code exports top-level `decideSafety`, not a class method. This is a **should-fix** precision issue.
- Flagged WorkflowContext’s “specific server or tool” wording versus spec’s server-only auto-approve semantics. Decide whether v0.5 intentionally limits to server-level approvals or add per-tool semantics.

### gemini-3.1-pro-preview
- Found the spec ready overall and confirmed major anchors/protocol choices.
- Suggested documenting the Windows `cmd /c npx` UX tradeoff and cleaning stale “Phase 8” terminology in `SafetyPolicy` comments during implementation.

### claude-opus-4.7
- Highlighted FR-008 “rejected or de-duplicated” as non-deterministic; pick one behavior.
- Flagged FR-025’s “HTTP allowed only for localhost/loopback or requires warning” as ambiguous; define the exact policy and verification branch.
- Suggested pinning placeholder format/fallback for binary/image content and clarifying form-based vs JSON-style settings entry.

## Specialist Findings

### Security / Threat-Modeling
- **Verdict:** NEEDS-REVISION.
- **Must-fix themes:** no explicit `shell:false`/no interpolation requirement; incomplete secret denylist; missing size/time bounds; missing SSRF/private-IP/metadata protections; redirect token leakage; auto-approve keyed by mutable display name; collision/source-spoofing risk; `Mcp-Session-Id` leakage outside `data.json` not prohibited.
- **Should-fix themes:** cwd default, safe rendering of approval prompts, untrusted-content isolation in preamble, local audit log, reveal-token UX safeguards, plaintext `data.json` sync warning.

### Operational Resilience
- **Verdict:** NEEDS-REVISION.
- **Must-fix themes:** no tool-call/handshake timeout policy; auto-reconnect lacks concrete bounds; HTTP/SSE liveness and single-flight initialize are unspecified; tool identity/refresh atomicity is not pinned.
- **Should-fix themes:** parallel shutdown or aggregate unload cap; in-flight disposition on disable/remove/reconnect; discard late responses after cancellation; connected-status semantics; stderr caps; handshake timeout; grant revocation on identity changes; response/frame size caps; bounded HTTP DELETE on shutdown.

## Priority Actions

### Must-fix before planning
1. Add explicit timeout and bounded-I/O requirements for initialize, tools/list, tools/call, JSON-RPC frames, HTTP bodies/SSE accumulation, stderr diagnostics, and total tool/page counts.
2. Quantify FR-018 reconnect behavior: schedule, jitter, max attempts/budget, reset rule, and crashloop terminal UI state.
3. Define concrete MCP tool identity/namespacing, cross-server duplicate behavior, built-in collision prevention, source spoofing prevention, and refresh atomicity.
4. Tighten child-process security: no implicit shell interpolation, command/args separation, cwd default, env denylist covering common cloud/AI secrets.
5. Tighten HTTP security: URL host classification/SSRF controls, non-local HTTP warning/confirmation semantics, redirect Authorization behavior, session-id redaction outside persistence.
6. Key persistent/session auto-approve grants to stable server identity and define revocation on remove/rename/transport/command/url changes.

### Should-fix before final sign-off
1. Restore or explicitly waive v0.4-style User Stories, Edge Cases, Assumptions, Scope, and Risks sections, with FR-to-story mapping.
2. Clarify `2024-11-05` compatibility against supported transport framing and legacy HTTP+SSE rejection.
3. Make success criteria human-verifiable and split broad failure-mode SCs into specific observable scenarios.
4. Resolve NFR-005 bundle-size target versus research estimate/waiver language.
5. Pick deterministic duplicate-tool behavior (`reject` vs `dedupe`) and deterministic HTTP plaintext policy.
6. Correct the `SafetyPolicy.decideSafety` anchor name.
7. Specify safe UI rendering/truncation for approval prompts and binary/image placeholders.

### Consider / polish
1. Document Windows `cmd /c npx` setup expectations in user-facing docs.
2. Clean stale “Phase 8” comments in safety policy code during implementation.
3. Explicitly state Linux PATH posture and `/usr/local/bin`/Homebrew trust assumptions.
4. Capture sandboxing as a v0.5 non-goal/future hardening item.
5. Consider local audit/ring-buffer history for MCP invocations while preserving no-telemetry scope.

## Final Verdict

**NEEDS-REVISION**

The spec is strong, well-researched, and most integration anchors exist, but four of five reviewers found revision required. The blockers are not architectural; they are precision and testability gaps around security, bounded operation, transport recovery, tool identity, and approval persistence. Addressing the must-fix list should make the artifact planning-ready without changing the core scope.
