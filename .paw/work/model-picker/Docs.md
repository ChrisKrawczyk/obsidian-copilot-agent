# v0.4 Model Picker — As-Built Reference

> Captured at v0.4 shipping. Sources of truth for behavior are the Spec, ImplementationPlan, and the tests; this doc is for future contributors who need the system-level picture without reading the diff.

## 1. Scope

v0.4 ships a per-conversation model picker (chat-header dropdown), a global default-model setting, mid-conversation model swap that preserves history, and a full recovery surface (inline banners + Retry + lazy resolution + deferred SDK-session creation) that lets the plugin recover from a missing model list without a plugin reload. v0.3's multi-conversation model is unchanged.

## 2. Architecture

```
                    +--------------------+
                    |   CopilotClient    |  (per-vault SDK client; rebuilt on token rotation)
                    +---------+----------+
                              |
                              | listModels()
                              v
+-----------------+   subscribe   +-------------------+
| Settings UI     | <-----------  |   ModelCatalog    |  (single shared instance, plugin scope)
| (Default model) |               |                   |
+-----------------+               | state machine:    |
                                  |  loading | ready  |
+-----------------+   subscribe   |        | empty    |   <-- exposed via getState() / subscribe()
| ModelPicker     | <-----------  |        | error    |
| (one per view)  |               +---------+---------+
+--------+--------+                         |
         | onSelect(newId)                  | subscribe (recovery hook)
         v                                  v
+-----------------+              +---------------------+
| ChatView        | <----------- |  AgentSession        |
| handleModelPick |   metadata-  |  (per ConversationRuntime)
|  + handleSend   |    changed   |  - getModel()        |
+--------+--------+              |  - swapModel(id)     |
         |                       |  - hasDeferredSession|
         | runtime.setModelId    |  - hasPendingApprovals
         v                       +----------+----------+
+-------------------+                       |
| ConversationRuntime|  swapModel/setModel  |
|  setModelId        +----------------------+
+--------+----------+
         | persist via store
         v
+--------------------+
| ConversationsStore | (v2 persisted shape: optional modelId per conversation)
+--------------------+
```

**Key invariant:** the `ModelCatalog` is the ONLY surface that calls `client.listModels()` for the picker — `AgentSession` consults the catalog's cached `chatModels` first and only falls back to a per-session `listModels()` when the catalog is non-ready.

## 3. State machines

### 3.1 ModelCatalog

```
                refresh()
   loading <------------- (any)
      |
      v
   listModels() throws?
      |              |
      | yes          | no
      v              v
    error          chatModels.length === 0 ?
   { message }       |          |
                     | yes      | no
                     v          v
                   empty     ready
                             { models, chatModels }
```

- `loading` is transient — visible only while a refresh is in flight.
- Exclusion policy (FR-012): HARD-disable on `policy.state === "disabled"` OR `disabled === true`. Soft signals (ids matching `/embedding|image|dall-e|whisper|tts/i`) are `console.warn`-ed but pass through unchanged.

### 3.2 Picker view-model (`buildModelPickerViewModel`)

```
catalogState == loading              -> { kind: "loading", label: "…" }
catalogState == ready                -> { kind: "ready", rows, currentId, currentLabel }
catalogState == empty | error        -> { kind: "degraded", label }   <-- non-interactive
```

When `ready` AND the active conv's bound `modelId` is missing from `chatModels`, the picker prepends a sentinel row `{ id: <bound>, label: "<id> (unavailable)", unavailable: true, isCurrent: true }` so the user can see WHICH stale id is bound; the sentinel is rendered disabled in the menu so it cannot be re-selected.

### 3.3 AgentSession init / recovery

```
   constructor (subscribes to ModelCatalog)
       |
       v
   init()
       |
       v
   start() + ping() ----+
                        |
                        v
                  pickModel() --------------+
                        | succeeds          | throws
                        v                   v
                  createSession()       catalog wired AND non-ready?
                        |                   |              |
                        v                   | yes          | no
                  selectedModel set      defer:           throw
                  deferredSession=false  - keep client    (init rejects;
                                         - session=null     onAuthError fires
                                         - deferred=true    when applicable)
                                         - init resolves
                                            |
                catalog -> ready notify     |  swapModel(newId)
                          \                 v          /
                            tryRecoverDeferred(?id) --+
                                |
                                v
                          createSession() in-place
                          selectedModel set
                          deferredSession=false
```

`stopRuntime()` clears `deferredSession = false` so the next `init()` runs the standard path (token rotation reset). `dispose()` unsubscribes the catalog listener.

## 4. Swap orchestration

`handleModelPick(newId)` in ChatView, source of truth for the user-driven swap:

1. **Identity check** (`isIdentitySwap`): if `newId === conv.modelId`, snap the picker back and return (no I/O).
2. **Zero completed turns fast-path** (`shouldConfirmSwap`): if no `assistant && status==="complete"` message exists, skip the dialog.
3. **Confirmation** (`confirmDestructive` + `buildSwapConfirmCopy`): if `hasPendingApprovals` is true, the dialog body appends "Any pending tool approvals will be cancelled." Cancel returns without touching state.
4. **Atomic swap**: `isSwapInProgress = true`; `runtime.setModelId(newId, { persist: true })` → `AgentSession.swapModel(newId)` cancels pending approvals, aborts any in-flight turn, calls `session.setModel(newId)`, and only on resolution updates `selectedModel` + `preferredOverride`.
5. **Finally**: re-render the picker (label snaps back on failure; reflects new id on success).

## 5. Send gating (FR-014)

`canSend(snapshot)` in `modelPickerLogic.ts` returns `{ ok: true }` or `{ ok: false, reason, kind }`. Precedence (highest first):

| kind | Condition | UI surface |
|---|---|---|
| `connection-loss` | `!isConnected` | Notice + "Open settings to connect" button |
| `streaming` | `isStreaming` | Send button repurposed as Stop (own UX) |
| `pending` | `isPending` | Send button shows loading state (own UX) |
| `unavailable-model` | catalog ready AND `activeModelId` not in `chatModels` | Inline banner: `Model `<id>` is no longer available. Pick a model to continue.` |
| `catalog-error` | catalog state is `error` | Inline banner: `Models unavailable: <message>` + **Retry** button |
| `catalog-empty` | catalog state is `empty` | Inline banner: `No chat models available.` (no Retry) |
| `unresolved-model` | catalog non-ready AND no `activeModelId` | Inline banner: `No model selected. Pick a model to continue.` |

`ChatView.refreshSendGate()` re-evaluates on every state change (catalog, manager, auth, busy, streaming). The send button is disabled iff `!ok` (except during streaming, where it's repurposed). The four catalog/model kinds drive the inline banner; the auth/streaming/pending kinds have their own established UX surfaces and the banner stays hidden.

## 6. Persistence (v1 → v2)

```jsonc
// v2 conversation shape (additive over v1)
{
  "id": "conv-2",
  "name": "Daily standup notes",
  "createdAt": 1717174800000,
  "lastActiveAt": 1717174900000,
  "modelId": "gpt-4o",          // <-- new in v2; string | null | absent
  "messages": [ ... ],
  "undoEntries": [ ... ]
}
```

- `modelId === undefined` ⇒ v0.3-migrated; lazy-resolved on first activation in v0.4.
- `modelId === null` ⇒ v0.4 conversation created while the catalog was degraded (resolver returned null); lazy-resolved on first activation OR via deferred-init recovery.
- `modelId === "<id>"` ⇒ explicit binding; honoured at construction time and survives reload.

The conversations subtree schema version is bumped from v1 to v2, but the migration is additive and backward-compatible: v1 payloads upcast by adding `modelId: null`, and v2 also accepts a missing field as unresolved.

## 7. Lazy resolution (FR-013)

`ConversationManager.setActive(id)` → `maybeLazyResolveModelId(id)`:

1. If conv already has a non-empty string `modelId`, no-op.
2. Otherwise call `resolveCreationModelId()` (configured-default-then-catalog-heuristic).
3. If it returns a string, `setConversationModelId(id, resolved)` persists it; the runtime is built lazily afterwards and reads the resolved id from `cloneMeta(conv)`.
4. If it returns null (catalog still degraded), conv stays unresolved — `canSend()` → `unresolved-model` → inline banner.

`onUnavailableDefault(configuredDefault)` fires when the configured default exists but isn't in the ready catalog — surfaces a one-shot Notice via main.ts.

## 8. SDK dependency notes

- `client.listModels()` — used by both `ModelCatalog.refresh()` (UI-facing) and `AgentSession.pickModel()` (fallback when the catalog isn't ready). The SDK doesn't expose a public "is this model chat-capable?" discriminator; the catalog applies `filterChatCapable()` with the FR-012 exclusion policy.
- `session.setModel(id)` — used by `AgentSession.swapModel()`. The SDK preserves session state (conversation history) across `setModel()`. If the SDK build doesn't expose `setModel`, `swapModel` throws and the picker shows an error Notice.
- `session.disconnect()` / `client.stop()` — used by `tryRecoverDeferred` to dispose a half-built session if the runtime is torn down during `createSession()`. Race-safety guard: `initEpoch` captured before each await, re-checked after.

## 9. Recovery walkthroughs

### A. Network down at startup
1. `main.ts` onload → `modelCatalog.refresh()` rejects → catalog `error`.
2. Each `ConversationRuntime` is constructed; `AgentSession.doInit()` runs, `pickModel()` fails (catalog non-ready + listModels throws), sets `deferredSession = true`, returns OK.
3. ChatView opens, picker is non-interactive (degraded), inline banner shows "Models unavailable" + **Retry**.
4. User clicks Retry → `modelCatalog.refresh()` succeeds → state flips to `ready`.
5. AgentSession's catalog subscription fires → `tryRecoverDeferred()` creates the SDK session in-place.
6. Banner disappears; `canSend()` returns ok; send button enables. No reload.

### B. Stale persisted modelId (e.g. "gpt-banana")
1. Conv hydrates with `modelId: "gpt-banana"`. Catalog reaches `ready` (without that id).
2. Picker shows `gpt-banana (unavailable)` as the checked item; inline banner shows "Model `gpt-banana` is no longer available. Pick a model to continue."; send blocked.
3. User picks a real model from the picker → `handleModelPick` → `runtime.setModelId("gpt-4o", { persist: true })` → `swapModel("gpt-4o")` (the session was already created for "gpt-banana", so the SDK swap is a normal in-place setModel).
4. Persisted modelId updated; banner clears on next refresh.

### C. v0.3-migrated conversation
1. v0.3 conv hydrates with no `modelId`. Catalog reaches `ready`.
2. User clicks the conv → `setActive` → `maybeLazyResolveModelId` → resolver returns `gpt-4o` → `setConversationModelId` persists it.
3. Runtime is built lazily with the resolved id; picker shows "gpt-4o". Stable across reloads.

## 10. FR / NFR / SC traceability

| Req | Covered by | Tests |
|---|---|---|
| FR-001 Per-conv model | ChatView ModelPicker + ConversationManager.modelId | `modelPickerLogic.test.ts`, `ConversationManager.test.ts` |
| FR-002 Discoverable picker | ChatView header mount (FR-015 merge) | manual + `ModelPicker` rendering tests |
| FR-005 Mid-conv swap preserves history | `AgentSession.swapModel` calls `session.setModel` | `AgentSession.test.ts` swapModel cases |
| FR-007 Default-model setting | Settings dropdown + `resolveCreationModelId` | `ConversationManager.test.ts` creation-time |
| FR-008 Confirmation gating | `shouldConfirmSwap` + `confirmDestructive` | `modelPickerLogic.test.ts` |
| FR-010 Unavailable-id state | Sentinel row + canSend `unavailable-model` | `modelPickerLogic.test.ts` Phase 5 |
| FR-012 Capability filter | `filterChatCapable` (hard only) | `ModelCatalog.test.ts` |
| FR-013 Lazy resolution | `ConversationManager.maybeLazyResolveModelId` | `ConversationManager.test.ts` lazy-resolution |
| FR-014 Single-source send gate | `canSend()` + `ChatView.refreshSendGate` | `modelPickerLogic.test.ts` canSend |
| FR-015 Header layout merge | `ChatView.onOpen` header-row + status pill collapse | manual |
| FR-016 Empty-catalog UX | Inline banner `catalog-empty` | `modelPickerLogic.test.ts` |
| FR-018 Retry affordance | Inline-error Retry button | manual + `canSend` |
| NFR-002 Picker render ≤ 16 ms | `buildModelPickerViewModel` is synchronous; pure | structural assertion in `modelPickerLogic.test.ts` |
| S1 Deferred createSession | `doInit` defer + `tryRecoverDeferred` + catalog sub | `AgentSession.test.ts` deferred-init |
| SC-001 No data loss | additive v1 → v2 schema | hydration tests |

## 11. What's NOT in v0.4

Embedding/vector models, model-side capability filtering beyond `policy.state === "disabled"`, per-conversation safety overrides, mid-conversation token-budget tracking, archived-conversation restore UI, model-picker search/filter input, sharing model picks across vaults, telemetry on model usage.

## 12. Operational reference

- **Test suite:** `npm test` (728 tests as of v0.4). Pure modules in `src/ui/modelPickerLogic.ts` are exhaustively tested; DOM modules (`ModelPicker.ts`) are validated via integration with ChatView.
- **Typecheck:** `npm run typecheck` (strict mode).
- **Build:** `npm run build` (esbuild production bundle).
- **Deploy:** `npm run deploy` (copies dist + manifest + styles to `$OBSIDIAN_PLUGIN_DIR`).
- **Manual verification checklist:** see `ImplementationPlan.md` § Phase 5 "Manual Verification".
