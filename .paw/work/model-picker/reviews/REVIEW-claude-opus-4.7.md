# Final Review — v0.4 Per-Conversation Model Picker

- **Reviewer model:** claude-opus-4.7
- **Date:** 2026-06-12
- **Branch:** `feature/model-picker` (base: `main` @ `7d15d7f`)
- **Strategy:** local, single-model
- **Quality gates (pre-review):** `npm test` 728/728 green, `npm run typecheck` green, `npm run build` green
- **Artifacts read:** `Spec.md`, `ImplementationPlan.md`, `CodeResearch.md`, `Docs.md`, full diff against `main`
- **Lens:** correctness/maintainability (primary), UX/accessibility (primary), security/privacy (secondary)

---

## Summary

This is a high-quality, well-staged delivery. The plan was unusually rigorous; the implementation follows it closely. Persistence migration is properly gated to avoid the catastrophic schema-bump-wipes-vault scenario the plan flagged. The `ModelCatalog` state machine, `canSend()` precedence taxonomy, deferred-init recovery, and the FR-012 fail-open soft-signal-vs-hard-exclusion contract are all faithfully and clearly implemented. Documentation (`Docs.md`, `CHANGELOG.md`, `README.md`) is exceptionally thorough.

I found two material issues — one is a real correctness bug against **FR-006** (mid-stream swap placeholder finalization) and one is a plan-deliverable divergence in migration normalization that arguably makes the data-loss surface **worse** than the plan's design. Both are should-fix at minimum. Several smaller findings follow.

Ship/no-ship: **ship after addressing F-1 and F-2** (or accept the divergences explicitly and ship; neither blocks happy-path use).

---

## Findings

### F-1 — Mid-stream model swap finalizes placeholder as `error`, not `interrupted` (FR-006 regression)

- **Severity:** should-fix (arguably must-fix — directly contradicts a P1 acceptance scenario)
- **Lens:** correctness
- **Affects:** Spec FR-006, FR-004 acceptance #4, SC-007; ImplementationPlan Phase 3 §"swapModel" step 2 and Phase 3 Test "(interrupted finalization)"

**Issue.** When the user confirms a model swap during a streaming turn, the spec requires the in-flight turn be "interrupted (its placeholder finalized as `interrupted`) before the model swap takes effect on the next user message." The plan was explicit (Phase 3 implementation step 2):

> mirror `ChatView.handleStop()` behavior ... set the streaming placeholder's status to `interrupted` BEFORE calling `cancelCurrent()`, so the SDK abort is bucketed as a clean interruption rather than as `error` by the finalization path at `src/ui/ChatView.ts:727-805`.

The implementation does NOT do this. `ChatView.handleModelPick` (`src/ui/ChatView.ts:566-616`) goes straight from the confirmation dialog to `runtime.setModelId(newModelId, { persist: true })`. That call reaches `AgentSession.swapModel` (`src/sdk/AgentSession.ts:928-987`), which calls `cancelCurrent()` — but no code path on the swap route sets `this.userRequestedStop = true` or calls `streamState.interruptStreaming(this.currentPlaceholderId)` the way `handleStop()` does (`src/ui/ChatView.ts:707-720`).

Trace of the actual finalization:

1. `cancelCurrent()` → SDK iterator throws an abort error
2. The streaming loop's `} catch (err) { failure = err; }` at `src/ui/ChatView.ts:936-937` captures it
3. At `:947` `const cancelled = this.userRequestedStop;` is read — but `userRequestedStop` is `false` because nothing set it
4. Therefore the `if (failure)` branch at `:954-960` fires, writing `content: "Error: …"`, `status: "error"`, AND a `new Notice("Copilot Agent error: …")`

So the user who confirms a mid-stream swap sees:

- The previous turn's placeholder rendered as `**Error:** <abort message>` (status `error`), not `interrupted`
- An Obsidian Notice popping up with "Copilot Agent error: …"

That directly violates FR-006 ("placeholder finalized as `interrupted`") and gives the user a misleading error UX on an action that succeeded.

**Why no test caught this.** The plan promised two integration tests that would have caught this:

- Phase 3 `AgentSession.test.ts (interrupted finalization)` — "when `swapModel()` is invoked during an in-flight stream, the streaming placeholder is finalized as `interrupted` (NOT `error`)"
- Phase 4 `ChatView.test.ts (cancel-during-stream)` — pinning Spec edge case `Spec.md:168`

Neither test exists. `grep` for `swap.*interrupted`, `interrupted.*swap`, `streaming` in `src/ui/*.test.ts` returns zero swap-driven hits. The only swap-during-stream test (`AgentSession.test.ts:1122-1132`) asserts `h.abortCalls === 1` but never asserts the placeholder's `status`, because that lifecycle lives at the ChatView layer the test doesn't drive.

**Proposed fix.** In `ChatView.handleModelPick`, between the confirm-ok branch and `runtime.setModelId(...)`, mirror `handleStop()`'s placeholder-freeze before yielding to the swap:

```ts
this.isSwapInProgress = true;
// FR-006: freeze the placeholder as `interrupted` BEFORE the SDK
// abort flows through cancelCurrent(); otherwise the catch-error
// branch in handleSend would finalize it as `error` and pop a
// misleading Notice.
if (this.streaming && this.currentPlaceholderId && this.currentStreamState) {
  this.userRequestedStop = true;
  try {
    this.currentStreamState.interruptStreaming(this.currentPlaceholderId);
  } catch (e) {
    console.warn("[ChatView] interruptStreaming during swap threw", e);
  }
}
try {
  const runtime = this.manager.getActiveRuntime();
  await runtime.setModelId(newModelId, { persist: true });
} catch (e) { … }
```

Then add the missing planned tests:

- ChatView integration test: confirm-during-stream finalizes prior placeholder as `interrupted` (NOT `error`), no Notice fires, the swap is applied, and the next send is dispatched to the new model.
- Companion cancel-during-stream test pinning `Spec.md:168` (no `userRequestedStop` set, stream completes normally as `complete`).

---

### F-2 — Migration rejects whole conversations subtree on any structurally-invalid `modelId` (plan deliverable divergence; arguable FR-014/NFR-005 risk)

- **Severity:** should-fix
- **Lens:** correctness / data safety
- **Affects:** ImplementationPlan Phase 1 §"`migrate.ts`" explicit text; `src/persistence/migrate.ts:139-187`; `src/persistence/migrate.test.ts:273-283`

**Issue.** Plan Phase 1 was explicit:

> Also extend `validateConversation()` itself to project `modelId` through with `typeof === "string" ? value : null` normalization (rejects numbers/objects to `null`).

Plan Phase 1 tests:

> verify structurally invalid `modelId` values (numbers, objects, arrays) normalize to `null`

The implementation does the opposite. `validateConversation` (`src/persistence/migrate.ts:152-159`) returns `null` for any `modelId` that is not `undefined`, `null`, or a non-empty string. Because `validateConversationsArray` (`:122-126`) returns `null` if **any** conversation fails to validate, and `migrate` (`:88-95`) sends a `null` result to the recovery sidecar (`recovered: true`), the failure mode is:

- A single corrupted `modelId: 42` on one conversation → the **entire** `conversations` subtree (potentially dozens of legitimate conversations with intact messages and undo journals) is sidecar-ed and replaced with `DEFAULT_CONVERSATIONS_STATE`.

The corresponding tests (`migrate.test.ts:273-283`) were rewritten to assert `recovered === true`, so the divergence is consistent within itself but invisible — the planning artifact says one thing, the code does another, and the test pinned the new behavior rather than the planned behavior.

Note this is the exact "wipe every v0.3 vault on first v0.4 load" failure class the plan called out as catastrophic (FR-014 / NFR-005) and structured the v1→v2 upcast around. The plan's normalize-to-null design exists *specifically* to make a `modelId` corruption non-destructive.

**Proposed fix.** Match the plan: normalize invalid values to `null` so a single bad field doesn't trash siblings.

```ts
// modelId: optional. Accept undefined (missing), null, or non-empty
// string; anything else normalizes to null (per plan §Phase 1) so a
// single corrupted field on one conversation cannot blow away the
// whole conversations subtree to recovery.
let modelId: string | null | undefined;
if (c.modelId === undefined) modelId = undefined;
else if (typeof c.modelId === "string" && c.modelId.length > 0) modelId = c.modelId;
else modelId = null;
```

…and update `migrate.test.ts:273-283` to assert `state.conversations[0].modelId === null` and `recovered === false` for the number/object/empty-string cases. (If the team has decided that strict rejection is actually safer than the planned permissive behavior, the divergence should be explicitly documented in `Docs.md` §6 and the plan amended to reflect the as-built decision — the worst outcome is a silent divergence.)

---

### F-3 — `decidePickerKeydown` reducer + tests are shipped but never wired into the ModelPicker (FR-017 fulfilled, but ~100 lines of dead code in the bundle)

- **Severity:** consider
- **Lens:** maintainability / plan-deliverable consistency
- **Affects:** ImplementationPlan Phase 4 §"Implementation" — `modelPickerLogic.ts` keyboard reducer & §"Tests" — keyboard state machine

**Issue.** The plan defined a fully-fledged pure keyboard reducer (`decidePickerKeydown` at `src/ui/modelPickerLogic.ts:187-226`) and a comprehensive test suite (14 tests at `modelPickerLogic.test.ts:165-310`). It is never invoked from anywhere in `src`:

```
$ rg "decidePickerKeydown" src
src/ui/modelPickerLogic.test.ts:12, 169, 181, 192, …  (tests only)
src/ui/modelPickerLogic.ts:187  (definition)
```

`ModelPicker.ts` (`:60`) only wires `click`. FR-017 ("Enter/Space to open, arrows to navigate, Enter to select, Escape to dismiss") is effectively delivered because (a) a native `<button>` translates Enter/Space to a `click` event by default, and (b) Obsidian's `Menu` widget handles in-menu arrow/Enter/Escape navigation natively. So the requirement is met without the reducer — but the reducer is still in the shipped bundle as dead code.

**Proposed fix.** Either:

1. Wire it up (add a `keydown` listener on `this.buttonEl` that calls `decidePickerKeydown` and dispatches the resulting action, OR mount it on the menu items if Obsidian's menu doesn't already cover all FR-017 cases) — and add an integration test that exercises a `KeyboardEvent`-driven open/navigate/select round-trip; OR
2. Delete the reducer + its tests with a short comment in `ModelPicker.ts` documenting that native `<button>` + Obsidian `Menu` handle FR-017 already.

Either way, the as-built `Docs.md` should make the choice explicit so future contributors don't get the wrong impression about which path is authoritative.

---

### F-4 — Picker click handler runs even while a turn is streaming, opening a confirmation dialog under a streaming UI (UX inconsistency with `canSend()`)

- **Severity:** consider
- **Lens:** UX

**Issue.** The send surface is centrally gated by `canSend()` (`modelPickerLogic.ts:319-381`) including a `streaming` block. The picker, however, is reachable from `kind: "ready"` view-model regardless of stream state — the picker button is enabled whenever the catalog is ready. A user clicking the picker mid-stream gets the confirmation dialog and, on confirm, hits F-1's broken interrupt path.

A small UX defensive measure independent of the F-1 fix:

- Either include the picker in the `canSend === streaming` disable-set (visually grey, click is a no-op), OR
- Adjust the confirmation copy specifically when `this.streaming === true` to say "Switching to <model> will interrupt the current response. Continue?"

This is a soft finding, and Spec FR-004 / FR-006 imply mid-stream swap is supported, so don't disable outright unless the team thinks that's better UX. Copy adjustment is the lower-risk path.

---

### F-5 — Settings unavailable-default Notice fires only once per Settings open; no Notice on conversation creation when default is unavailable

- **Severity:** consider
- **Lens:** UX / spec conformance

**Issue.** FR-007 / Spec edge case "Global default unavailable at conversation creation" requires a Notice when the default is unavailable at the moment of conversation creation. The Settings UI surfaces it once per Settings open (`SettingsTab.ts:391-392`). The creation-time path in `main.ts:502-507` does provide an `onUnavailableDefault` Notice — good. But this fires every time a conversation is created with an unavailable default, with no de-duplication. For a user creating many conversations in a session (e.g. project-onboarding) under a stale default, this can become noisy.

**Proposed fix.** Either dedupe by `configuredDefault` value within `ConversationManager` (suppress repeats while the configured value hasn't changed) OR document the current behavior in `Docs.md` §6 as intentional ("repeats are intentional — they tell the user the default is still broken").

---

### F-6 — `swapModel` no-op early-return diverges subtly from `selectedModel = newModelId` invariant when `deferredSession` is true

- **Severity:** consider
- **Lens:** correctness / maintainability

**Issue.** `AgentSession.swapModel` (`src/sdk/AgentSession.ts:935-940`):

```ts
if (this.selectedModel === newModelId && !this.deferredSession) {
  this.preferredModelOverride = newModelId;
  return;
}
```

This guards identity-swap against also matching the deferred-init state — good. But if a caller calls `swapModel("X")` twice in close succession while deferred, the second call will re-enter the deferred-recovery branch at `:946-951` and call `tryRecoverDeferred("X")` again. `tryRecoverDeferred` guards on `this.session` being null (`:1297`) so the second call is a near-no-op, but the second call also unconditionally sets `selectedModel = newModelId` and `preferredModelOverride = newModelId`. Cheap, but worth a one-line guard for clarity:

```ts
if (this.deferredSession && this.client && !this.session) { …deferred recovery… }
```

Not user-visible, just maintainability.

---

### F-7 — `Docs.md` traceability table references "FR-014 Single-source send gate" and "SC-001 No data loss" which don't match the Spec's FR/SC numbering

- **Severity:** consider
- **Lens:** documentation

**Issue.** `Docs.md` §10 says:

- "FR-014 Single-source send gate" — but Spec FR-014 is "Migration MUST NOT break v0.3 sibling-key preservation" (`Spec.md:135`).
- "SC-001 No data loss" — Spec SC-001 is the picker happy-path scenario (`Spec.md:155`).

Probably a copy-paste of internal phase shorthand into the public traceability table. Fix by re-aligning the IDs in `Docs.md` §10 to the Spec's actual FR/SC text.

---

## What's solid (calling out the wins)

- **Persistence v1 → v2 upcast ordering** (`migrate.ts:54-78`) is exactly the fix the plan called for. The `if (version === 1)` branch precedes the equality check so v0.3 vaults survive cleanly — this was the highest-risk planning concern and is well-handled.
- **`ModelCatalog`'s soft-signal-vs-hard-exclusion** (`ModelCatalog.ts:50-78`) is implemented precisely as the plan specified, with the regression-guard rationale in a code comment. FR-012 fail-open is real.
- **Shared `CopilotClient` + provider closure** (`main.ts:266`, `rebuildSharedClient`) lets token rotations re-back the catalog without dropping subscribers — clean and consistent with v0.3 store patterns.
- **`canSend()` precedence taxonomy** (`modelPickerLogic.ts:319-381`) gives one decision function for the send button, Enter handler, and inline banner. The four blocked states each have an unambiguous reason string.
- **Deferred-init recovery** (`AgentSession.ts:928-987`, `tryRecoverDeferred`) genuinely recovers without plugin reload. The `initEpoch` guard against race-with-teardown is a nice extra step the plan didn't fully spell out.
- **`Docs.md`** is a model artifact — architecture diagram, state machines, recovery walkthroughs, and the explicit "what's not in v0.4" all present. The diagram even reflects the deferred-init flow.

---

## Ship/no-ship

**Recommendation: ship after F-1 and F-2 are addressed**, ideally with the F-3 dead-code decision made (delete or wire) so future contributors aren't misled.

F-1 is the only finding that directly produces user-visible misbehavior (mid-stream swap shows `**Error:**` + Notice instead of an interrupted-and-replaced flow). The fix is small (~10 lines in `ChatView.handleModelPick`) and accompanied by the two integration tests the plan already promised. F-2 is silent until a corrupted byte hits a `modelId`, at which point the consequence is severe — also fix before shipping to a broader audience.

F-3 through F-7 are quality-of-life polish. None block ship.
