# Plan Review — Per-Conversation Model Picker (v0.4)

**Reviewer model:** claude-opus-4.7
**Artifact under review:** `.paw/work/model-picker/ImplementationPlan.md` (synthesized)
**Disclosure:** my own per-model draft (`plans/PLAN-claude-opus-4.7.md`) was an input to the synthesis. I have tried to critique the synthesis honestly rather than rubber-stamp content I helped author.

---

## Verdict: **PASS-with-fixes**

The plan is well-structured, faithful to the spec, and traceable line-by-line through the FR/NFR/SC matrix. Phase ordering is defensible and each phase has concrete tests. However, there are two **must-fix** issues that materially affect either shippability of an intermediate phase or the safety of the persistence migration, plus a handful of should-fix gaps around the "deferred `createSession()`" contract and a small number of citation hygiene problems.

---

## Coverage Summary

| Spec ID | Covered? | Where |
|---------|----------|-------|
| FR-001 | ✅ | Phase 1 (shape + round-trip test) |
| FR-002 | ✅ | Phase 4 |
| FR-003 | ✅ | Phase 1 (`setConversationModelId`) + Phase 4 (call site) |
| FR-004 | ✅ | Phase 4 (`confirmDestructive`, identity & empty-transcript carve-outs) |
| FR-005 | ✅ | Phase 3 (`AgentSession.swapModel()` → `session.setModel()`); explicit "do NOT call resetConversation" guard |
| FR-006 | ✅ | Phase 3 (cancelCurrent → setModel ordering) |
| FR-007 | ✅ | Phase 2 (resolver) + Phase 3 (createInternal call site) — but see must-fix #1 |
| FR-008 | ✅ | Phase 2 (Settings dropdown) |
| FR-009 | ✅ | Phase 3 (resolution-at-creation; existing convs unmutated) |
| FR-010 | ✅ | Phase 5 (banner + picker `(unavailable)` row) |
| FR-011 | ✅ | Phase 5 (`canSend()` extension) |
| FR-012 | ✅ | Phase 2 (fail-open with explicit "positive signal only" framing + dedicated unit fixture) |
| FR-013 | ✅ | Phase 1 (`null` sentinel) + Phase 5 (lazy-resolve on first activation) |
| FR-014 | ✅ | Phase 1 (sibling preservation test asserts top-level `auth`/`safety` survive) |
| FR-015 | ✅ | Phase 4 (status-pill merge; Option A) |
| FR-016 | ✅ | Phase 2 + 5 (empty state distinct from error; no retry button) |
| FR-017 | ✅ | Phase 4 (pure keyboard reducer in `modelPickerLogic.ts`) |
| FR-018 | ✅ | Phase 2 (catalog state) + Phase 5 (UI retry) |
| NFR-001 | ✅ | Phase 2 + 4 (cached open, no SDK round-trip) |
| NFR-002 | ⚠️ | Phase 4 manual verification only — no automated assertion (see consider #1) |
| NFR-003 | ✅ | "Additive tests only" stance + plan to keep existing v0.3 tests untouched |
| NFR-004 | ✅ | Phase 3 explicit `liveRuntimes.size` regression test |
| NFR-005 | ✅ | All phases + Phase 6 manual smoke for Undo/raw-FS/archive/rotation |
| SC-001..008 | ✅ | All present in matrix; SC-003 traceability has the must-fix #1 wrinkle |

**Phase Candidates section:** Present (lines 66–79). Reasonable list of deferred items; no orphaned or speculative entries.

**SDK behavior:** Every SDK claim in the plan is grounded in CodeResearch citations (`session.d.ts:250-265`, `index.js:5639-5654`). There is no speculative SDK behavior asserted — the plan correctly treats `setModel()` as the FR-005 commit point and does not assume atomicity (Phase 3 risks section explicitly notes this). ✅

---

## Findings

### MUST-FIX

#### M1. Phase 2 claims default-model shippability that actually depends on Phase 3

**Location:** lines 60 ("Phase 2 ... Shippable: default-model setting works on creation"), 84 ("Settings ships standalone — it only resolves on creation"), vs. line 61 + 219–224 (Phase 3 scope owns `createInternal()` resolution).

**Problem:** Phase 2's scope (lines 144–151) lists `SettingsTab`, `SafetySettingsStore`, the catalog, and the `pickModel()` refactor. It does **not** list `ConversationManager.createInternal()`. The actual write of `modelId` at conversation creation lives in Phase 3 (line 219, "ConversationManager.createInternal(): Resolve `modelId` per FR-007 at creation time"). As specified, after Phase 2 alone the Settings UI accepts a default but no `createInternal()` call site reads it — SC-003 is therefore not satisfied at the Phase 2 boundary, contradicting the "shippable" claim.

**Fix options (pick one):**
- (a) Move the `createInternal()` resolution into Phase 2 scope and adjust Phase 3 to own only the swap mechanic.
- (b) Reword Phase 2's shippability claim to: "Settings UI lands and the catalog is wired; default-model creation semantics activate in Phase 3."

Option (b) is lower-risk (keeps Phase 3 as the runtime-behavior phase) but requires updating both the phase-status bullet (line 60) and the ordering rationale (line 84).

#### M2. Schema bump to v2 collides with current `migrate.ts` "unknown version → recovery" behavior

**Location:** Plan line 108 ("Bump `schemaVersion` to `2` in `PersistedConversationsState`") and line 109 ("Add a no-op v1 → v2 step that seeds `modelId: null`").

**Problem:** Current `src/persistence/migrate.ts:44-46` reads `obj.schemaVersion` and treats **any** value other than `CURRENT_SCHEMA_VERSION` as a recovery trigger (i.e., it sidecars the user's data and resets to defaults). If the implementer literally bumps `CURRENT_SCHEMA_VERSION` to `2` without first restructuring `loadFromRaw()` to accept v1 and migrate it forward, **every v0.3 vault would recover (effectively wipe its conversations) on first v0.4 load** — a catastrophic NFR-005 / FR-014 regression that the FR-014 test (sibling-key preservation) might not catch because that test seeds `CURRENT_SCHEMA_VERSION` directly.

The plan's wording "Add a no-op v1 → v2 step" is correct in spirit but understates the contract change: `migrate.ts` must learn an explicit `version === 1 → upcast to v2` branch *before* the version equality check, not after. This is a structural change to the migration entry point, not a "no-op."

**Fix:** In Phase 1's Implementation section, replace the one-liner with explicit instructions:
- Modify `loadFromRaw()` so `version === 1` is a recognized prior version that upcasts (project conversations through `validateConversation()` with `modelId: null`) rather than triggering recovery.
- Add a regression test in `migrate.test.ts`: a payload with `schemaVersion: 1` and full v0.3 conversation rows MUST round-trip to a v2 state with `modelId: null` on each conversation AND `recovered: false`. This test, not the existing recovery test, is the one that proves M2 has been addressed.

Without this, the v1→v2 bump is the single highest-risk line item in the plan.

---

### SHOULD-FIX

#### S1. "Deferred `createSession()`" mechanism is under-specified across Phase 2 and Phase 5

**Location:** Phase 2 line 161 ("If the catalog is in failure/empty state, `doInit()` defers `createSession()` until a usable id arrives"); Phase 5 line 343 ("first-send remains the trigger that finally creates the SDK session if it wasn't created at runtime construction").

**Problem:** The "deferred init" contract has no single owner. Three open questions:
1. *Who calls the un-deferred `createSession()` and when?* Catalog-becomes-ready event? First send? Both?
2. *What state does `AgentSession` expose while deferred?* (`canSend()` needs to know.)
3. *Is there a test that asserts a runtime constructed during catalog failure correctly initializes after a successful retry without plugin reload?* — this is the SC-008 happy path and is not in the listed Phase 5 tests (line 350).

**Fix:** Add to Phase 5 Implementation an explicit subsection naming the deferred-init trigger (e.g., "`AgentSession` subscribes to `ModelCatalog`; when the catalog transitions `error|empty → ready` and the runtime has no `selectedModel`, it resolves an id and calls `createSession()`"). Add a corresponding automated test: catalog starts in `error`, runtime constructed, retry succeeds, send-without-reload works.

#### S2. FR-005 "next user-message boundary" has no concrete test

**Location:** FR-005 spec text says "A confirmed swap MUST take effect at the next user-message boundary…"; Phase 3 line 250 acknowledges the race ("a swap between user-clicks-Send and stream-actually-starts could land mid-RPC") and defers to Phase 4 ("UI enforces 'next user-message boundary'"); Phase 4 tests (lines 292–293) cover confirmation/cancel/identity but NOT the user-message-boundary ordering guarantee.

**Fix:** Add a Phase 4 (or Phase 3) automated test that exercises the sequence "send-in-progress → user clicks confirm-swap → stream finalizes as `interrupted` → next user message is dispatched against the new model id" and asserts the model id observed by the SDK send call. Without this, FR-005's most important behavioral guarantee is only checked by manual verification (line 305).

#### S3. Spec citations to non-existent acceptance-criteria identifiers

**Location:** Plan line 167 ("FR-007 acceptance #4"), line 223 ("FR-007 acceptance #4"), line 277 ("FR-004 acceptance #5"), line 167 in Settings impl.

**Problem:** Spec.md FR-004, FR-007 are single-paragraph requirements with no numbered acceptance list. The "#4" / "#5" identifiers are spurious — they appear to refer to bullet points in earlier-draft user-story acceptance lists. They will confuse implementers cross-checking the spec.

**Fix:** Replace with the actual spec section being referenced — e.g., for the "Notice when default unavailable" cases, cite "Spec.md Edge Cases: Global default unavailable at conversation creation" (Spec.md line 169). For empty-transcript, cite the FR-004 sentence directly.

#### S4. `doInit()` signature change scope is not enumerated

**Location:** Phase 2 line 161 changes `doInit()` from "fetches list itself" to "accepts an externally-resolved model id."

**Problem:** `doInit()` is called from `CopilotAgentSession` construction paths in `main.ts` and may have test fixtures that construct sessions directly (e.g., `AgentSession.test.ts`). The plan lists the test file but does not call out that any direct construction sites in production code or tests must adapt to the new signature. A grep for `doInit` call sites should be part of Phase 2 Implementation, not implicit.

**Fix:** Add to Phase 2 Implementation: "Update all `doInit()` callers (enumerate via grep) to pass the resolved id; tests that previously seeded a fake `listModels()` response now seed an id directly."

---

### CONSIDER

#### C1. NFR-002 (≤16 ms picker update on conversation switch) has no automated guardrail

The plan relies on subscriber-driven re-render and manual verification (line 304). This is acceptable — DOM render benchmarks are flaky in unit tests — but a lightweight assertion that the picker view-model is computed synchronously (no `await` in the subscriber path) would protect against future regressions. Optional.

#### C2. "Pending approvals will be cancelled" copy is conditional but not state-tracked

Phase 4 line 284 says the modal appends "Any pending tool approvals will be cancelled" *if* pending approvals exist. The data needed for this (`agentSession.hasPendingApprovals()` or equivalent) is not enumerated as a new accessor in Phase 3 scope. Either it already exists (worth confirming via grep on `cancelAllPendingApprovals`/the approval store) or it should be added to Phase 3 scope.

#### C3. SDK-side history preservation is asserted but not empirically verified

CodeResearch documents that `setModel()` "preserves conversation history" per SDK type docs. Plan correctly does not claim more than that. However, no test in the plan verifies empirically that, after a swap, the SDK can recall content from a pre-swap turn (e.g., "ask the new model to summarize what was just said"). Manual verification line 242 ("response is demonstrably from the new model; scrollback intact") covers UI scrollback but not SDK-side memory. Listing this as a manual smoke item in Phase 6 (NFR-005 enumeration) would close the gap without overcommitting to a brittle automated test.

#### C4. `Phase Candidates` could absorb "deferred-init contract" if S1 is punted

If the team decides not to fully specify the deferred-init trigger in Phase 5, that work belongs in Phase Candidates with an explicit note. Don't leave it implicit in the prose.

---

## Independent-Shippability Assessment

| Phase | Independently shippable? | Notes |
|-------|--------------------------|-------|
| 1 | ✅ (after M2 fix) | Pure persistence; round-trip test gates risk. |
| 2 | ⚠️ (M1) | As written, ships infra without behavior. Either wording or scope must change. |
| 3 | ✅ | Programmatic-API-only scope is genuinely shippable; e2e via devtools `runtime.setModelId`. |
| 4 | ✅ | UI on top of green Phase 3 substrate. |
| 5 | ✅ (after S1) | Recovery flows; deferred-init owner must be named. |
| 6 | ✅ | Documentation only. |

---

## Strategic / Quality Notes (positive)

- The "family-prefix list as positive signal only" framing for FR-012 (line 160 + line 189) is a meaningful guardrail — fail-open is genuinely the most likely place an implementer would silently regress, and the dedicated unit fixture is the right fix.
- The `canSend()` precedence rule (line 340) collapses four blocked states into one taxonomy, which is the correct abstraction. The synthesis improved on my draft here.
- Splitting the picker into `ModelPicker.ts` (DOM owner) and `modelPickerLogic.ts` (pure reducer) mirrors the established `chatKeydown.ts` pattern and is testable in node — good architectural call.
- Risks sections per phase are concrete and tied to mitigations rather than hand-waving.
- The "do NOT call `resetConversation()`" guarded comment (line 217) is exactly the kind of in-code safety net that prevents a future contributor from quietly defeating FR-005.

---

## Recommended Next Step

Apply M1 + M2 (must-fix) and S1 + S3 (should-fix) before implementation begins. S2 and the consider-items can be addressed during their phase if they slip. The plan is otherwise ready.
