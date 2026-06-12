# Spec Review — model-picker (claude-opus-4.7)

**Verdict:** PASS-with-fixes
**Criteria passing:** 22 / 26
**Findings:** 11 (0 must-fix, 5 should-fix, 6 consider)

The spec is well-structured, traceable, and covers the headline UX (header picker,
confirmation dialog, SDK session reset, persistence, recovery, global default,
chat-capable filter). v0.3 baseline preservation is explicit via SC-006. Fixes
below are scoped — none block transition to planning, but several would tighten
the contract before CodeResearch begins.

---

## Should-fix

### S1 — Implementation detail leakage in FRs / NFRs / Assumptions
**Criterion:** Content Quality → "No code snippets, file paths, API signatures, class names."
**Affected sections:** FR-003, FR-005, NFR-004, Assumptions.

The spec leaks runtime identifiers and file paths that belong in CodeResearch, not
in the user-facing contract:

- FR-003 — "persist via the existing **debounced flush path**" (implementation mechanism).
- FR-005 — "the existing SDK session is **disposed**, a new one is **created**" (prescribes implementation).
- NFR-004 — references the `liveRuntimes` set in `main.ts` (file + symbol).
- Assumptions — names `CopilotAgentSession`, `client.createSession({ model, ... })`, `src/sdk/AgentSession.ts`, `SafetySettingsStore`, and "v0.3 pattern".

**Fix direction:** Restate FR-003/FR-005/NFR-004 in behavioral terms ("the selection
is persisted under the same durability guarantee as conversation rename"; "the new
model becomes the session's bound model before the next user turn is dispatched —
no SDK state from the prior model leaks into the new turn"). Move concrete
symbol/file references to a "for CodeResearch" sub-bullet in Assumptions or strip
them entirely — CodeResearch is responsible for finding the v0.3 callsites.

### S2 — Success Criteria lack FR ID linkage
**Criterion:** Requirement Completeness → "SCs reference relevant FR IDs."
**Affected sections:** Success Criteria table.

The SC table has no `FRs` column. The Traceability matrix at the end maps
*stories* to FRs/SCs, but a reviewer cannot, looking at SC-004 alone, see which
FRs it validates. SC-006 in particular ("v0.3 baseline behaviors remain green")
maps to *no* FR by design — that should be made explicit too.

**Fix direction:** Add an `FRs` column to the Success Criteria table. Mark
SC-006 as "(baseline — no FR, see Traceability cross-cutting row)".

### S3 — "Mid-conversation" trigger for confirmation dialog is underspecified
**Criterion:** Edge cases / FR testability.
**Affected sections:** FR-004, P1 mid-conversation swap story.

FR-004 requires confirmation for "mid-conversation" swaps but never defines the
threshold. The acceptance scenario uses "in-flight conversation with several
turns." Unclear cases:

- Conversation has been created but zero user turns sent — confirmation required?
- One user turn sent, no assistant response yet — required?
- Assistant has streamed exactly one reply — required?

This matters because FR-005 (replay transcript as initial context) is a no-op
when the transcript is empty, so confirmation arguably adds friction with no
information value at turn-count = 0.

**Fix direction:** Define the trigger explicitly. Suggested rule: "confirmation
required iff the persisted transcript contains ≥1 assistant turn (i.e. there is
SDK-side context that will be lost)." Update FR-004 and the acceptance scenario.

### S4 — NFR-003 hard-codes a brittle baseline metric
**Criterion:** SCs measurable / Assumptions documented.
**Affected sections:** NFR-003.

"611 baseline test count from v0.3" hard-codes a number that will drift the
moment any unrelated test is added or merged. It also presupposes
implementation-test architecture in the spec.

**Fix direction:** Replace with a behavioral contract: "v0.4 MUST NOT cause any
previously-passing v0.3 test to fail." Drop the count. If a numeric baseline is
needed for planning, capture it in CodeResearch where it can be re-measured.

### S5 — No FR/edge case for SDK model-list fetch failure
**Criterion:** Edge cases enumerated.
**Affected sections:** FR-016, Risks.

FR-016 covers the *empty* case (SDK returned zero chat-capable models). NFR-001
says the list is fetched once at onload and cached. But the spec does not cover
the *fetch failure* case (network error, auth not yet ready, SDK throws). The
empty and failure cases have different user-facing semantics: empty = "you have
no access," failure = "we couldn't ask Copilot."

**Fix direction:** Add an FR or edge case: "If the onload model-list fetch fails,
the picker enters a 'Models unavailable — retry' state with a retry affordance;
sendMessage is blocked with the same inline-error pattern as FR-011." Or
explicitly fold failure into the empty-state behavior of FR-016 and say so.

---

## Consider

### C1 — Swap-to-same-model is not specified as a no-op
**Affected sections:** FR-004, FR-005.

If the user opens the picker and re-selects the currently-bound model, is the
confirmation dialog shown? Is the SDK session reset? A reasonable contract is
"identity swap is a no-op — no dialog, no session reset." Worth one sentence in
FR-004.

### C2 — Cancel-during-mid-stream swap path is implicit
**Affected sections:** P1 mid-conversation swap, acceptance scenario #4.

Scenario #4 covers "confirm during stream → interrupt." Cancel during stream is
not enumerated. Implicitly the stream continues uninterrupted; making it
explicit prevents implementer guesswork.

### C3 — Recovery for "global default became unavailable"
**Affected sections:** FR-007, FR-010, P2 Recovery story.

FR-010 covers per-conversation unavailable models. What if the *global default*
in Settings points to an id that is no longer in the SDK list? When a new
conversation is created, does it inherit the broken id (triggering FR-010
immediately) or fall back to `pickModel()`? Worth one sentence.

### C4 — Cached model list staleness
**Affected sections:** NFR-001.

The cached list is fetched once at onload. If the user's Copilot entitlements
change during the session (model added/removed), the picker shows stale data
until reload. Not necessarily a bug — but worth either listing as an explicit
known limitation or adding a manual "refresh models" affordance.

### C5 — Transcript-replay token-limit risk lacks a falsifiable contract
**Affected sections:** Risks (row 3), FR-005.

The risk row says "send full transcript and let the SDK error if oversized;
iterate if observed." That is a deferred decision, but no SC asserts the
behavior. If a planner reads this, they may either trim, not trim, or implement
a soft-cap — three different outcomes all "spec-compliant." Either tighten the
contract or explicitly mark this as "planning decides."

### C6 — Overview / Objectives sections not labeled
**Affected sections:** Top of spec.

The spec opens with a blockquote summary and a "Problem Statement" — together
these substitute for an "Overview" and implicit "Objectives." Not strictly
wrong, but the PAW spec template names these sections explicitly and downstream
review skills look for them by header. Consider renaming/restructuring to match
template conventions.

---

## Criteria pass/fail summary

| Group | Pass | Fail | Notes |
|-------|------|------|-------|
| Content Quality (6) | 5 | 1 | No code artifacts (S1) |
| Narrative Quality (5) | 4 | 1 | Overview/Objectives labels (C6) |
| Requirement Completeness (6) | 5 | 1 | SCs linked to FR IDs (S2) |
| Ambiguity Control (2) | 2 | 0 | — |
| Scope & Risk (2) | 2 | 0 | — |
| Research Integration (n/a) | — | — | No SpecResearch.md present |
| **Behavioral coverage (reviewer-added)** | — | — | S3, S4, S5 + C1–C5 are coverage gaps |

## Focus-area verdicts (per reviewer prompt)

- **Story completeness & independent testability:** PASS. Each story has Given/When/Then scenarios and a concrete Independent Test recipe.
- **FR coverage of stated UX:** PASS-with-fixes. Mid-conv swap + confirmation + SDK reset + persistence + recovery + global default + chat filter are all present. Gaps: confirmation trigger threshold (S3), identity-swap (C1), default-became-unavailable (C3), fetch-failure (S5).
- **Acceptance scenarios concrete & falsifiable:** PASS. Each scenario points at an observable outcome (model id in pill, inline error string, etc.).
- **Risks realistic / assumptions flagged for CodeResearch:** PASS. Risks are concrete with mitigations; Assumptions explicitly defer SDK-shape questions to CodeResearch.
- **Traceability stories ↔ FRs ↔ SCs:** PASS-with-fixes. The story↔FR↔SC matrix is intact; SC↔FR direct linkage is missing (S2). NFR-004 appears in the story-FR column where only FRs are expected — minor consistency nit.
- **Missing edge cases:** S3, S5, C1, C2, C3, C4 enumerate them.
- **v0.3 baseline preservation contract (SC-006):** PASS. Explicit enumeration of streaming, Stop control, approvals, token rotation, soft-cap/archive, Undo journal, raw-FS gating, vault preamble.

## Recommendation

Proceed to planning after addressing S1–S5. Consider items can be folded into
planning notes or CodeResearch questions rather than blocking spec iteration.
