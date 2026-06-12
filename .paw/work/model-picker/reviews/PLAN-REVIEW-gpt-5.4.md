# Plan Review — Per-Conversation Model Picker

**Verdict:** BLOCK

## Summary

- **Spec coverage:** PASS. The plan explicitly maps **FR-001..018**, **NFR-001..005**, and **SC-001..008** in the coverage matrix and phase breakdown (`ImplementationPlan.md:414-448`).
- **Research alignment:** PASS. The plan correctly anchors FR-005 on SDK `CopilotSession.setModel()` and explicitly forbids reset/recreate semantics (`ImplementationPlan.md:13-15`, `ImplementationPlan.md:211-217`, `CodeResearch.md:23-24`, `CodeResearch.md:65`, `CodeResearch.md:203-210`).
- **Completeness:** PASS. `What We're NOT Doing`, `Phase Candidates`, documentation planning, file scopes, and measurable validation sections are present (`ImplementationPlan.md:40-56`, `ImplementationPlan.md:66-80`, `ImplementationPlan.md:375-410`).
- **Phase feasibility / shippability:** FAIL. The current phase split leaves degraded model-catalog states partially implemented before the plan introduces the user-facing recovery and send-gating needed to keep intermediate releases non-broken.

## Findings

### 1) must-fix — Phases 2–4 are not independently shippable under degraded catalog/model states
- **Why this matters:** The review bar requires each phase to ship without leaving the plugin in a broken intermediate state. The current plan defers the recovery contract to Phase 5, but earlier phases already make runtime/session behavior depend on catalog readiness.
- **Evidence:**
  - Phase 2 changes `doInit()` so it no longer resolves models internally and explicitly defers `createSession()` when the catalog is in `failure/empty` state (`ImplementationPlan.md:161-167`).
  - Phase 3 allows new conversations to persist `modelId: null` when the catalog is `failure/empty`, again deferring correctness to Phase 5 (`ImplementationPlan.md:219-223`).
  - Phase 4 mounts picker UI for error/empty/unavailable states, but its `canSend()` scaffold is hardcoded to `ok: true` until Phase 5 (`ImplementationPlan.md:272-289`).
  - The actual blocked-send / retry / inline-error behavior required by FR-010, FR-011, FR-016, and FR-018 does not arrive until Phase 5 (`ImplementationPlan.md:335-345`; `Spec.md:131-139`).
- **Required revision:** Re-cut the boundaries so any phase that can surface `error`, `empty`, unavailable-id, or unresolved-id states also includes the corresponding non-broken send gating / retry / recovery behavior, or explicitly preserve current behavior until that same phase lands.

### 2) must-fix — FR-012 / SC-005 filtering is not specified concretely enough to exclude known non-chat models
- **Why this matters:** The plan says FR-012 is covered in Phase 2, but the proposed rule is "positive-signal only" and "never an exclusion gate," which leaves no concrete mechanism for excluding clearly non-chat models while still satisfying the spec’s first clause.
- **Evidence:**
  - Phase 2 defines `filterChatCapable()` as dropping disabled models and using a known-chat family prefix list only as a positive signal, while everything unmatched passes through (`ImplementationPlan.md:155-160`).
  - The corresponding tests only assert disabled-model exclusion and fail-open behavior for unknown families (`ImplementationPlan.md:171-172`).
  - The spec still requires the picker to show only chat-capable models when the metadata distinguishes them (`Spec.md:133`, `Spec.md:159`).
  - Code research explicitly says there is no public chat/embedding/image discriminator (`CodeResearch.md:21-24`, `CodeResearch.md:201-208`).
- **Required revision:** Specify the exact non-chat exclusion rule the implementation will use, grounded in researched evidence, or explicitly narrow the planned acceptance/coverage statement so the plan does not claim stronger filtering than the available SDK signals can support.

### 3) should-fix — NFR-005 baseline preservation is explicit, but the per-phase regression strategy should be made more phase-local
- **Why this matters:** The plan repeatedly states that v0.3 behavior must remain green, but the most sensitive baseline checks are still expressed mostly as whole-suite reruns and end-of-plan/manual smoke.
- **Evidence:**
  - Global verification mentions full-suite automation and manual baseline smoke (`ImplementationPlan.md:35-38`).
  - NFR-005 is mapped broadly to all phases plus documentation (`ImplementationPlan.md:440`, `Spec.md:149`).
  - The highest-risk phases (3–5) do include targeted tests, but the plan does not explicitly map existing v0.3 regression tests/smokes to the baseline behaviors enumerated in NFR-005 (streaming, Stop, approvals, token rotation, archive flow, Undo, raw-FS gating, vault-aware preamble).
- **Suggested revision:** Add a compact regression matrix naming the existing tests/smokes that protect each NFR-005 baseline behavior in the phases most likely to disturb them.

## Overall Assessment

The plan is strong on coverage, research integration, ordering rationale, and its explicit use of SDK `setModel()` for FR-005. `Phase Candidates` is present, and no phase depends on session recreate-and-reseed semantics contradicted by the research. However, the current phase split is not yet safe enough to ship incrementally, and FR-012’s filtering contract needs tightening before implementation proceeds.
