# Spec Review — model-picker

- **Verdict**: **BLOCK**
- **Criteria Passed**: **14 / 21** (SpecResearch criteria N/A; no `SpecResearch.md` present)
- **Findings**: **5**

## Summary

The spec covers the requested UX surface areas: per-conversation model selection, mid-conversation swap confirmation, SDK-session reset behavior, persistence, unavailable-model recovery, global default selection, and chat-capable filtering. Most acceptance scenarios are concrete and independently testable.

The blocking issues are internal consistency and traceability: the default/null semantics conflict with the persistence story, transcript replay is both required and optional in different sections, and the v0.3 baseline-preservation contract is not anchored to a normative FR/NFR. In addition, the document is missing the expected Overview/Objectives narrative structure and still contains implementation/code artifacts that should move to CodeResearch/planning.

## Findings

### 1) must-fix — Default/null semantics conflict with persistence and “prospective only” default behavior
- **Criteria**: Testable stories; FR completeness; traceability integrity
- **Affected sections**: `Persistence across reloads`, `Global default model in Settings`, `FR-001`, `FR-007`, `FR-009`, `FR-013`, `SC-002`, `SC-003`
- **Issue**: `FR-001` says `modelId: null` means “use the global default,” and `FR-013` says migrated v0.3 conversations keep using that fallback at **use time**. But the P2 default story and `FR-009` say changing the global default is **prospective only** and must not change existing conversations. A persisted conversation that remains `null` would drift when the global default changes, which breaks the persistence story and makes expected behavior hard to test.
- **Suggestion**: Decide whether conversations must always persist a resolved model once created, or whether `null` is migration-only and gets normalized at a defined point. Then align the stories, FRs, and SCs around one behavior.

### 2) must-fix — Transcript replay is both required and optional
- **Criteria**: FR completeness; SC measurability; assumptions clarity
- **Affected sections**: `Mid-conversation swap with confirmation`, `FR-005`, `SC-007`, `Assumptions` (transcript replay bullet)
- **Issue**: The story, `FR-005`, and `SC-007` promise that the new SDK session receives the persisted transcript as context after a model swap. The assumptions section then says that if the SDK lacks a seeding mechanism, the implementation **may** proceed without transcript context and merely surface that limitation. Those are materially different user-visible behaviors, so the acceptance path is not stable enough for planning.
- **Suggestion**: Either keep transcript replay as a hard requirement and mark SDK support as a blocking CodeResearch question, or explicitly redefine the UX/SCs for the degraded behavior.

### 3) must-fix — SC-006 does not have a normative requirement anchor
- **Criteria**: SC measurability; SC linkage; traceability integrity
- **Affected sections**: `NFR-003`, `SC-006`, `Traceability`
- **Issue**: `SC-006` is carrying the v0.3 preservation contract (streaming, Stop, approval prompts, token rotation, archive flow, Undo journal, raw-FS gating, vault-aware preamble), but the traceability table has a blank FR column for that row and there is no single FR/NFR that normatively states the full preservation requirement. That makes the baseline contract explicit only at the success-criterion layer, not at the requirement layer the plan and tests should trace back to.
- **Suggestion**: Add an explicit FR/NFR for baseline preservation, map `SC-006` to it, and consider splitting the criterion into smaller observable checks or subcriteria.

### 4) should-fix — Spec is still carrying code artifacts and implementation detail
- **Criteria**: User value focus; no code artifacts
- **Affected sections**: title block / opening summary, `Problem Statement`, `FR-005`, `NFR-004`, `Assumptions`
- **Issue**: The spec references code-level artifacts and APIs such as `pickModel()`, `sendMessage`, `client.createSession({ model, ... })`, `CopilotAgentSession`, `main.ts`, `liveRuntimes`, and store/class names. That pulls the document below the intended “WHAT/WHY” abstraction level for a spec.
- **Suggestion**: Move code/API/file references into CodeResearch or the implementation plan, and keep the spec phrased in observable user/system behavior.

### 5) should-fix — Missing required narrative scaffolding and a couple of likely edge cases
- **Criteria**: Overview present; Objectives present; edge cases
- **Affected sections**: document intro / `Problem Statement`, `FR-010`–`FR-016`, `Assumptions`
- **Issue**: The spec does not include the expected 2–4 paragraph `Overview` section or an `Objectives` section. It also does not explicitly cover two realistic unavailable-model paths the implementation will hit: (1) the configured **global default** becoming unavailable before a new conversation is created, and (2) a migrated/`null` conversation resolving to an unavailable default on load.
- **Suggestion**: Add Overview/Objectives sections, and extend the unavailable-model coverage so those default-resolution cases have explicit expected behavior and tests.

## Positives

- Story priority ordering is clear (`P1`/`P2`/`P3`).
- Each story includes at least one acceptance scenario and an independent test.
- The requested UX areas from the brief are represented in stories/FRs/SCs.
- Risks are realistic overall and several assumptions are already flagged for CodeResearch.

## Re-Review (v2)

- **Verdict**: **PASS-with-fixes**
- **Criteria Passed**: **20 / 21** (SpecResearch criteria N/A; no `SpecResearch.md` present)
- **Findings**: **1**

### Summary

Four of my five prior findings are now addressed, and the other reviewers' must-fixes are also addressed: the default/null contract is reconciled across `FR-007`/`FR-009`/`FR-013`, transcript replay is now a hard `FR-005` requirement with explicit CodeResearch gating if SDK seeding is unavailable, `SC-006` is anchored to `NFR-005`, the document now includes `Overview` and `Objectives`, the SC table includes FR/NFR linkage, `FR-004` defines the confirmation threshold, `NFR-003` no longer hard-codes the v0.3 count, and `FR-018` covers model-list fetch failure.

The remaining issue is that the spec still carries code-shaped artifacts in several normative sections, so I cannot yet mark the "no code artifacts" criterion fully resolved.

### 1) should-fix — Code-shaped artifacts still remain in the spec
- **Criteria**: User value focus; no code artifacts
- **Affected sections**: `FR-001`, `FR-006`, `FR-010`, `FR-013`, `FR-014`, `In Scope`
- **Issue**: The revised draft removed the largest implementation leaks called out previously (`pickModel`, `CopilotAgentSession`, file paths, `liveRuntimes`, API signatures), but it still names internal field/state artifacts such as optional `` `modelId` `` semantics, missing/`null` migration behavior, the literal finalized state `` `interrupted` ``, and persisted-shape wording in normative requirements. Those details are closer to data-structure design than user-observable contract.
- **Suggestion**: Restate those requirements in behavior-first language (for example, "each conversation stores its selected model," "migrated conversations without a stored selection resolve on first use," "the interrupted turn is visibly finalized") and leave concrete field/state naming to CodeResearch or planning.
