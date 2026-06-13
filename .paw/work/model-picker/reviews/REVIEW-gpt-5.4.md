# Final Review — v0.4 Model Picker

**Reviewer:** gpt-5.4  
**Date:** 2026-06-12  
**Diff reviewed:** `main...feature/model-picker`

## Verdict

**Findings:** 5 material issues  
**Security/privacy:** No material security or privacy issue observed in the reviewed diff.  
**Recommendation:** **No-ship** until the must-fix item and the should-fix spec/plan gaps below are addressed.

---

## 1) Model-swap confirmation can apply to the wrong conversation
**Severity:** must-fix

**Issue**  
`handleModelPick()` captures the active conversation before the confirmation modal, but after `await confirmDestructive(...)` it calls `this.manager.getActiveRuntime()` again. If the user switches conversations while the modal is open, the swap is applied to the *new* active conversation instead of the one they initiated the action from.

**Current code / refs**  
- `src\ui\ChatView.ts:569-572` captures the current conversation.  
- `src\ui\ChatView.ts:591-596` introduces the async gap.  
- `src\ui\ChatView.ts:608-609` then swaps `this.manager.getActiveRuntime()`.  
- `src\domain\ConversationManager.ts:284-290` shows `getActiveRuntime()` always resolves from the *current* `activeId`.

**Why this matters**  
This is a correctness bug: the wrong conversation can have its runtime swapped and persisted `modelId` changed.

**Proposed fix**  
Capture the target conversation/runtime before the modal, then after the await either use that captured runtime directly or re-check that `getActiveId()` still matches the original id and abort if it changed.

---

## 2) `modelId` persistence still falls back to unresolved/null in paths the spec said must be resolved and written
**Severity:** should-fix

**Issue**  
The implementation still preserves a v0.3-style unresolved path where new conversations can be created with `modelId: null`, and lazy resolution only runs from `setActive()`. That misses two explicit commitments:
- **FR-007:** new conversations must get a resolved `modelId` written at creation time, and if the cached catalog is unavailable a fresh `listModels()` call should be attempted first.  
- **FR-013:** migrated conversations should write back the resolved id on first use.

**Current code / refs**  
- Spec requirement: `.paw\work\model-picker\Spec.md:128,134`.  
- Plan minimum: `.paw\work\model-picker\ImplementationPlan.md:63,65`.  
- `src\main.ts:474-500` returns `{ modelId: null }` whenever the shared catalog is not `ready`; it never performs the spec’s fresh-`listModels()` creation-time fallback.  
- `src\domain\ConversationManager.ts:682-718` persists that unresolved/null result during `createInternal()`.  
- `src\domain\ConversationManager.ts:299-348` shows lazy resolution is only triggered by `setActive()`, so the initially active hydrated conversation never takes that path unless the user switches away and back.  
- Tests currently lock in the old behavior instead of the spec behavior: `src\domain\ConversationManager.test.ts:1033-1045`, `src\domain\ConversationManager.test.ts:1164-1205`.

**Why this matters**  
A conversation can successfully run on a resolved SDK model while still persisting `modelId: null`, which breaks the “resolved and written” contract and can cause reload/default-model semantics to drift from the actual model the user ended up using.

**Proposed fix**  
At creation time, if the shared catalog is non-ready, run the fresh `client.listModels()` + heuristic fallback required by FR-007 and persist that result immediately. Separately, ensure first-use resolution also writes back for the initially active migrated conversation (for example, by backfilling on first successful session init/send, not only on `setActive()`).

---

## 3) Migration behavior does not match the plan’s promised `modelId` normalization
**Severity:** should-fix

**Issue**  
The implementation rejects the entire conversation subtree when `modelId` is structurally invalid, but the implementation plan explicitly promised to normalize invalid `modelId` values to `null` instead.

**Current code / refs**  
- Plan promise: `.paw\work\model-picker\ImplementationPlan.md:111,119`.  
- Actual implementation: `src\persistence\migrate.ts:149-159` returns `null` for the whole conversation when `modelId` is an invalid non-empty-string/non-null value.  
- Tests now enforce that stricter behavior: `src\persistence\migrate.test.ts:183-184`, plus the invalid-value cases beginning at `src\persistence\migrate.test.ts:236`.

**Why this matters**  
This is a plan-deliverable gap, and it is harsher than necessary: a single malformed `modelId` can force recovery for otherwise valid conversation data instead of degrading safely to “unresolved.”

**Proposed fix**  
Make `validateConversation()` coerce invalid `modelId` values to `null` (per plan), keep the rest of the conversation intact, and update the tests accordingly.

---

## 4) Keyboard accessibility is only specified/tested in pure logic; it is not actually wired into the picker UI
**Severity:** should-fix

**Issue**  
FR-017 requires keyboard accessibility. The reducer for open/close/navigation/select exists and is heavily tested, but `ModelPicker.ts` never uses it. The live picker only listens for `click`, so the tested keyboard state machine is effectively dead code. README/CHANGELOG also claim inherited keyboard accessibility more strongly than the implementation proves.

**Current code / refs**  
- Spec requirement: `.paw\work\model-picker\Spec.md:138`.  
- `src\ui\modelPickerLogic.ts:187-226` implements `decidePickerKeydown(...)`.  
- `src\ui\modelPickerLogic.test.ts:165-228` (and following cases) tests that reducer extensively.  
- `src\ui\ModelPicker.ts:44-60` wires only a button + click handler; no picker `keydown` handling is present.  
- `src\ui\ModelPicker.ts:44-50` also omits `aria-expanded`, so screen-reader state is incomplete.

**Why this matters**  
This is both a UX/accessibility gap and a maintainability problem: the tests give false confidence that the shipped UI satisfies the keyboard contract.

**Proposed fix**  
Wire `decidePickerKeydown()` into the actual picker control (including open/arrow/select/escape behavior) and add the missing ARIA state (`aria-expanded`). If Obsidian `Menu` is intended to provide all of this, replace the custom reducer/tests/docs with integration coverage that proves the real behavior instead of leaving dead logic in-tree.

---

## 5) Token-rotation refresh can be lost while a catalog refresh is already in flight
**Severity:** should-fix

**Issue**  
`ModelCatalog.refresh()` coalesces concurrent refreshes by returning the existing in-flight promise. During token rotation, `main.ts` rebuilds the shared SDK client and immediately calls `modelCatalog.refresh()`. If another refresh is already in progress, the token-rotation refresh request is dropped onto the old in-flight promise, and no follow-up refresh is queued once that stale request finishes.

**Current code / refs**  
- `src\sdk\ModelCatalog.ts:132-137` returns `this.inflight` without queueing another pass.  
- `src\sdk\ModelCatalog.ts:142-159` captures the client once per refresh.  
- `src\main.ts:523-533` rebuilds the shared client and then calls `modelCatalog.refresh()` during token rotation.

**Why this matters**  
A rotation can leave the catalog stuck on an error or stale data until the user manually retries, which undermines the recovery story this feature is supposed to improve.

**Proposed fix**  
Queue one follow-up refresh when `refresh()` is requested during an in-flight run, so token rotation always triggers at least one refresh against the new shared client after the stale request settles.

---

## Summary

The feature is close, but I would **not ship it as-is**. The biggest risk is the must-fix conversation-switch race in the confirmation flow. After that, the main gaps are around spec/plan fidelity for `modelId` persistence and the fact that keyboard accessibility is more asserted than actually implemented.
