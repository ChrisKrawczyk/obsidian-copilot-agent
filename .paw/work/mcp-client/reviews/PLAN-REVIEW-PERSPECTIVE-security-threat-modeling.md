# PLAN REVIEW PERSPECTIVE - security/threat-modeling

- Specialist: Security & Threat-Modeling Reviewer
- Artifact under review: `.paw\work\mcp-client\ImplementationPlan.md` (v0.5 MCP Client Integration)
- Supporting docs: `Spec.md`, `SpecResearch.md`, prior `SPEC-REVIEW-PERSPECTIVE-security-threat-modeling.md`
- Source baseline: `C:\Repos\obsidian-copilot-agent\src\`
- Review scope: approval gates, child-process spawning, env handling, persistence of configs/grants, HTTP transport safety, logging/redaction, prompt/tool injection, command/path validation, trust boundaries, and regressions vs. current v0.4 code.

## Verdict

**NEEDS-REVISION**

The plan correctly maps every spec security control (FR-022 env denylist, FR-025 URL/TLS posture, FR-004 `shell: false`, FR-024 stdin→SIGTERM→SIGKILL, FR-019 in-memory `Mcp-Session-Id`, FR-012 stable-identity grants, FR-030 escaped approval text, FR-013 no-Undo for MCP) to a concrete phase, file, and test. The phase ordering enforces the right safety-before-execution invariant: identity (Phase 1) → safety gate (Phase 2) → headless runtime (Phase 3) → UI/lifecycle (Phase 4) → bridge (Phase 5) → resilience (Phase 6). However, several controls are described at the level of "we will test this" without specifying *where in the execution path the enforcement lives*, leaving holes that the test surface as planned will not detect — most importantly, redirect/Authorization stripping inside the SDK's HTTP transport, the source-keyed Undo suppression, and synthetic-id parser safety against attacker-supplied tool names. None require redesign.

---

## Specialist Findings

### MUST-FIX

#### MUST-1 — `httpPolicy.ts` is config-time only; the runtime SDK transport must also enforce redirect cap and cross-origin Authorization stripping
- **Evidence:** Plan §Phase 3 (lines 160–161) introduces `src\mcp\httpPolicy.ts` for "URL validation, TLS posture, metadata-host rejection, private-network confirmation classification, redirect cap and Authorization stripping on cross-origin redirect." Phase 3 changes describe `McpServerRuntime.ts` wrapping `client/streamableHttp.js`, but neither §Changes nor §Required Tests specify how those *runtime* redirect/header rules are wired into the SDK's `StreamableHTTPClientTransport`, which uses its own `fetch` internally. The `httpPolicy.test.ts` plan (line 169) only covers classification of URLs at config time ("reject non-loopback `http://`", "drop Authorization across origins", "cap redirects at 3") — these become guarantees only if the SDK transport actually respects them at request time.
- **Impacted requirements:** FR-005, FR-025, NFR-003.
- **Security consequence:** Without a custom `fetch` wrapper (or explicit `redirect: "manual"` plus per-hop validation) the SDK will follow redirects with default `redirect: "follow"` semantics, which on Node's `undici`/Electron fetch *does* forward the original `Authorization` header on same-origin redirects but the rules are platform-dependent and have changed across Node versions. A redirect to a private IP, metadata host, or attacker-controlled origin would not be re-classified by `httpPolicy` because classification only runs at config-add time. Cap of 3 hops is also a runtime property of the transport, not the validator.
- **Recommended plan change:** In Phase 3 §Changes, add an explicit deliverable: `McpServerRuntime` constructs `StreamableHTTPClientTransport` with a custom `fetch` (or an interception hook) that (a) re-runs `httpPolicy.classifyHost` on every hop URL, (b) enforces `redirect: "manual"` and counts hops, (c) drops `Authorization` whenever `nextUrl.origin !== currentUrl.origin`, and (d) preserves `Mcp-Session-Id` only on same-origin hops. Add `McpServerRuntime.test.ts` cases for: 302 same-origin (header retained), 302 cross-origin (header dropped, request succeeds without it), 302→302→302→302 (rejected at hop 4), 302 to `169.254.169.254` (rejected). Plan currently has none.

#### MUST-2 — Undo suppression for MCP relies on absence of `undoId`, not on `source`
- **Evidence:** Plan §Phase 2 (line 128) says: "ensure MCP-source calls never show Undo, **even if a caller mistakenly attaches an `undoId`**." Existing `src\ui\ToolCallBlock.ts:45-55` `shouldRenderUndoButton` checks `outcome`, `undoId`, `undone`, `onUndo`, and `isUndoSuppressed(call.name)` — none of which inspect `call.source`. The plan adds a `ToolCallBlock.test.ts` row for "MCP Undo hidden" (line 134), but does not list an *implementation* change to the predicate that would make the "even if a caller mistakenly attaches an `undoId`" promise true.
- **Impacted requirements:** FR-013, NFR-007.
- **Security consequence:** Defense-in-depth is the stated goal. As planned, the only protection is the bridge electing not to set `undoId` (Phase 5) and `isUndoSuppressed` keyed by *tool name* — neither survives a future refactor that, e.g., routes a journaled write through MCP. An accidental Undo click on an MCP call would invoke `handlers.onUndo(undoId)` against the v0.4 vault Undo journal with an id that has no real journal entry, at best surfacing an error, at worst (depending on Phase 6 work) corrupting journal state.
- **Recommended plan change:** Phase 2 §Changes Required for `src\ui\ToolCallBlock.ts` must explicitly state: extend `shouldRenderUndoButton(call, handlers)` to accept `call.source` and return `false` when `call.source === "mcp"`; add this guard before the `undoId` check. Add a `ToolCallBlock.test.ts` row asserting that a call with `source: "mcp"` and a non-empty `undoId` and `outcome: "completed"` still returns `false` from `shouldRenderUndoButton`.

#### MUST-3 — Synthetic id parser/normalization rules for attacker-supplied `<tool-name>` are unspecified
- **Evidence:** Plan §Phase 5 (line 234) defines `mcp__<server-id>__<tool-name>` and adds `McpToolRegistry.ts` with "synthetic id mapping, duplicate/collision checks, built-in `mcp__` prefix guard". Plan §Phase 2 line 126 introduces `McpToolIdentity.ts` to "parse/format `mcp__<server-id>__<tool-name>` ids". Neither phase specifies what happens when the server returns `name: "__foo"`, `name: "bar__baz"`, `name: "mcp__other-server__steal"`, or names containing whitespace, NUL, control chars, or path separators. `McpToolRegistry.test.ts` (line 244) lists "cross-server duplicate", "same-server duplicate", "built-in collision", "disabled/disconnected" — none of which cover hostile names.
- **Impacted requirements:** FR-009, FR-012, FR-030, NFR-003.
- **Security consequence:**
  1. Parse ambiguity: with `__` as separator and `serverId = "a"`, a tool named `b__c` parses as `serverId="a", toolName="b__c"` only if the parser is "split on first `__` after `mcp__`". If split is greedy or naïve, `mcp__a__b__c` could be mis-attributed to server `a__b` (cross-server spoofing) and grants would apply to the wrong identity.
  2. Built-in prefix bypass: a tool named `mcp__vault__read_file` exported by a hostile MCP server would, after concatenation, produce `mcp__<hostile-id>__mcp__vault__read_file` — and after a future refactor or if the SDK ever re-prefixes, could collide with the reserved prefix.
  3. Grant key drift: if grants are keyed by raw `toolName` and the registry mid-normalizes (e.g., trims), the persistence layer and the policy layer would compute different keys for the same call. Approval would be requested under one key and grant recorded under another → re-prompt every call (mild) or silently grant a similar-looking tool (severe).
- **Recommended plan change:** In Phase 1 (`McpIdentity.ts`) add an explicit specification:
  - `serverId` regex (e.g., `^[a-z0-9][a-z0-9-]{0,63}$`), validated at config-add.
  - `toolName` accepted character set; reject or escape `\u0000`, control chars, whitespace runs, and any literal `__` runs that would alias the separator. State whether the runtime rejects the *whole inventory* for that server or just that tool — pick rejection (fail-closed) to avoid partial registration.
  - Parser MUST split on the first `__` after `mcp__` and treat the remainder as a single `toolName` opaque blob; document this in `McpToolIdentity.ts`.
  - Add `McpToolRegistry.test.ts` rows: name with embedded `__`, name with `mcp__` prefix, name containing NUL/control chars, name >256 chars.
  - State that grant keys are computed from the *registry-normalized* `toolName`, not the raw wire value, and that `formatMcpApprovalKey` is the single source of truth used by both policy and persistence.

#### MUST-4 — Explicit per-server `env` injection can re-introduce denylisted secrets without warning
- **Evidence:** Plan §Phase 3 (line 159) says `stdioEnv.ts` does "full-inherit-minus-denylist env builder, **explicit per-server env injection after filtering**". Spec FR-022 echoes the same order. Plan tests (line 168) verify that the denylist rejects inherited vars and that explicit env is "injected after filtering" — i.e., explicit env *overrides the denylist*.
- **Impacted requirements:** FR-022, NFR-003.
- **Security consequence:** A user who pastes a config from the web (or follows a malicious tutorial) can have `env: { OPENAI_API_KEY: "${OPENAI_API_KEY}" }` or similar — re-introducing the very secret the denylist is intended to strip, with no warning. The denylist's threat model is "the user does not realize ambient env contains secrets"; that same user does not realize the explicit-env override is a foot-gun.
- **Recommended plan change:** Phase 3 / Phase 4 must add: (a) `stdioEnv.ts` returns a structured result `{ env, explicitDenylistOverrides: string[] }`; (b) `McpServerRuntime` records `explicitDenylistOverrides` on connect and surfaces them in last-status diagnostics; (c) `mcpServerFormLogic.ts` flags any explicit env key matching the denylist with a Settings-UI warning ("This key matches the denylist of well-known secrets. Continue?"). Add `stdioEnv.test.ts` and `mcpServerFormLogic.test.ts` cases for explicit override of `GITHUB_TOKEN`, `OPENAI_API_KEY`, and a wildcard match (`MY_API_KEY`).

#### MUST-5 — stderr ring buffer is fully attacker-controlled and surfaced into Settings UI without an explicit safe-render contract
- **Evidence:** Plan §Phase 3 (line 162) captures "stderr ring buffer". Plan §Phase 6 §Changes Required (line 280) `McpServersSection.ts` shows "stderr diagnostics with non-color-only status and redaction". `McpServersSection.test.ts` (line 207) covers "redacted last-error rendering, accessible row labels" but does not specify that stderr is rendered as `textContent` / never injected as HTML, and `redact.ts` (line 161) only redacts `Authorization`, `Mcp-Session-Id`, and URL userinfo.
- **Impacted requirements:** FR-028, FR-030, NFR-003, NFR-008.
- **Security consequence:** A hostile MCP server can emit arbitrary bytes to stderr — including ANSI escape sequences, control characters, fake "approval granted" copy, embedded markdown/HTML, or strings shaped like other servers' last errors. If `McpServersSection` ever uses `innerHTML`, `el.setText()` is fine but `el.innerHTML =`, `MarkdownRenderer.render`, or a third-party highlighter on `stderr` would create a stored-XSS-equivalent inside the Settings tab. Even with `textContent`, control characters / very long lines could break tab layout or hide content.
- **Recommended plan change:** Phase 3 §Changes Required for `stdioEnv.ts` / runtime must say "stderr is captured as bytes, decoded as UTF-8 with replacement, and stripped of `\u0000`-`\u0008` / `\u000B`-`\u001F` / `\u007F` before storage." Phase 6 §Changes Required for `McpServersSection.ts` must state "stderr is rendered as `textContent` inside a `<pre>` element; no markdown/HTML rendering applies." Add `McpServersSection.test.ts` cases for ANSI escapes, NUL bytes, embedded HTML/markdown, and >64 KiB stderr (verifies the ring buffer cap holds).

#### MUST-6 — Trust-epoch lookup at decision time is not specified; risk of fail-open
- **Evidence:** Plan §Phase 2 (lines 124–125) extends `SafetyPolicyInput` with `mcpServerId`, `mcpToolName`, `mcpTrustEpoch` and updates `grantMcp`/`isMcpGranted` to exact scope. Plan §Phase 2 §Changes line 125 says `AgentSession.buildSafetyInput(...)` produces `source: "mcp"` and the exact MCP scope — but does *not* specify where `mcpTrustEpoch` is read from at call time. The manager owns the live trust epoch; the bridge sees a request from the SDK. If the manager has rotated the epoch (server renamed/repointed) while a call is in flight, what is the bridge's lookup?
- **Impacted requirements:** FR-012, FR-019, NFR-003.
- **Security consequence:** Two fail-open vectors:
  1. If `buildSafetyInput` reads `trustEpoch` from a stale registry snapshot held by `AgentSession`, a previously granted server/tool/epoch tuple matches and the call auto-approves even though the user just edited the config (which should have revoked the grant).
  2. If the bridge passes `trustEpoch: undefined` whenever lookup fails, the policy's "stale epoch fails closed" test (line 100) protects against absent epochs — but if the policy treats `undefined` as "skip epoch check" rather than "fail", granted scope expands silently.
- **Recommended plan change:** Phase 2 §Changes Required for `AgentSession.ts` and `McpToolBridge.ts` (cross-reference Phase 5) must state: `buildSafetyInput` looks up the *current* `trustEpoch` from a manager-provided synchronous accessor at decision time, not from a cached snapshot; if the accessor returns `null`/missing (server removed/disabled), `decideSafety` MUST decide `require-approval` (never `auto-apply`) and the bridge MUST reject before dispatching `tools/call`. Add `SafetyPolicy.test.ts` and `AgentSession.test.ts` rows: "missing trustEpoch → require-approval"; "epoch mismatch → require-approval"; "server removed between approval and dispatch → reject before tools/call".

#### MUST-7 — SDK stdio transport spawn options are assumed safe but not pinned by tests
- **Evidence:** Plan §Phase 3 line 170 says: "`McpServerRuntime.test.ts`: stdio spawn uses array args and `shell: false`". This describes the *contract* but the spawn actually happens inside `@modelcontextprotocol/sdk@1.29.0`'s `StdioClientTransport`, not in our code. Plan does not specify whether we (a) construct `StdioClientTransport` ourselves with our spawn options, (b) provide a pre-spawned child via the SDK's `StdioClientTransportOptions`, or (c) trust the SDK's internal `cross-spawn` defaults. `cross-spawn` historically *can* invoke a shell on Windows for `.cmd`/`.bat` resolution; the SDK has changed defaults between minor versions.
- **Impacted requirements:** FR-004, FR-022, NFR-003.
- **Security consequence:** If we trust the SDK and the SDK in 1.29.0 (or a future bump) uses `cross-spawn` with shell-resolution for `.cmd`/`.bat` on Windows, a user-pasted Windows `npx`-style command with attacker-controlled args could shell-interpret characters in args (`&`, `|`, `^`, `"`). The plan's documented escape hatch is "Windows users can explicitly configure `cmd` with args `["/c", "npx", ...]`" — that pattern only works if the SDK doesn't itself wrap the inner `args` in a shell call.
- **Recommended plan change:** Phase 3 §Changes for `McpServerRuntime.ts` must explicitly state: we own the child-process spawn (either by calling `child_process.spawn` directly and passing the resulting streams into the SDK's pluggable transport interface, or by constructing the SDK transport with explicit `shell: false` and verifying the SDK does not re-wrap on Windows). Add `McpServerRuntime.test.ts` Windows-specific case: spawn with `command = "cmd"`, `args = ["/c", "echo", "& notepad"]` — the child must receive `& notepad` as a single literal arg, never executed as a separate command. Pin `@modelcontextprotocol/sdk` to `1.29.0` exactly (no `^`) in `package.json` until tests cover behavior of newer SDK spawn paths.

#### MUST-8 — `Authorization` and `Mcp-Session-Id` redaction coverage does not include thrown error paths from the SDK
- **Evidence:** Plan §Phase 3 line 161 introduces `src\mcp\redact.ts` that "redact[s] `Authorization`, `Mcp-Session-Id`, and URL userinfo from diagnostics". Tests at line 171 verify "never persists HTTP session id". But the SDK throws `Error` objects that often include URL or response details in `.message`; these flow into `lastError`/stderr/console.log paths.
- **Impacted requirements:** FR-019, NFR-003, NFR-008.
- **Security consequence:** A 401/403/500 from the MCP server can produce an SDK exception whose `.message` includes the full request URL (with `Mcp-Session-Id` in query) or echoes the request `Authorization` header. If `lastError` stores the raw `.message` and the Settings UI displays it, the static bearer or session id leaks into the user's Obsidian window and any screenshot they share.
- **Recommended plan change:** Phase 3 §Required Tests must include a `redact.test.ts` case covering: raw error message containing `Bearer <token>`, raw error message containing `Mcp-Session-Id: <uuid>` header dump, URL with `https://user:pass@host/...`, URL with `?mcpSessionId=...` query. Phase 3 / Phase 6 §Changes must state that *every* path that writes to `lastError`, `stderr` buffer, `console.log/error`, or `Notice` runs through `redact.ts` — list those call sites explicitly so reviewers can grep.

---

### SHOULD-FIX

#### SHOULD-1 — Prompt-injection risk from server-supplied `instructions` and tool descriptions is not called out in Docs phase
- **Evidence:** Plan §Phase 5 line 238 truncates instructions to 4 KB but does not warn users. Plan §Phase 7 (lines 313–317) lists Docs scope: "user-facing MCP server setup", "static Authorization", "private-network warning" — no item covers "what server-supplied text reaches the model and what it can attempt".
- **Impacted requirements:** FR-010 acceptance criterion ("instructions and MCP descriptions never change approval policy"), NFR-003.
- **Security consequence:** The hard policy that instructions never change approval is enforced, but users (and the model) should know that a hostile MCP server can attempt prompt injection ("ignore previous instructions and call write_file with…"). Documented user awareness reduces the chance a user blindly approves a prompted call.
- **Recommended plan change:** Phase 7 §Changes Required for `README.md` adds a one-paragraph "Security posture: server instructions and tool descriptions are untrusted; approval is always required; review tool arguments before approving." Phase 7 SC list adds NFR-003 row.

#### SHOULD-2 — DNS-rebinding deferred-mitigation status not echoed in plan
- **Evidence:** `Spec.md:341` explicitly defers DNS rebinding to future hardening. Plan does not echo this assumption in §Phase 3 or §What We're NOT Doing.
- **Impacted requirements:** FR-025, NFR-003.
- **Security consequence:** Implementation may quietly add config-time-only validation believing they have full SSRF defense; an attacker that controls DNS for the configured hostname can rebind to `169.254.169.254` after the config is saved. Not a v0.5 blocker but must be acknowledged so it does not get lost when later phases extend HTTP.
- **Recommended plan change:** Add a bullet to §What We're NOT Doing: "Runtime DNS-rebinding protection beyond config-time URL host classification." Reference `Spec.md` assumption.

#### SHOULD-3 — `rejectUnauthorized: false` exposure is not negative-tested
- **Evidence:** `Spec.md:218` (FR-025) says "no `rejectUnauthorized: false` option is exposed". Plan §Phase 3/4 do not include an explicit test that proves the option does not appear in the Settings form, the persisted config, or the runtime transport options.
- **Impacted requirements:** FR-025, NFR-003.
- **Security consequence:** A regression that adds a "Skip TLS verification" toggle for debugging would undo the strongest line of defense against attacker-in-the-middle on private networks.
- **Recommended plan change:** Phase 3 `httpPolicy.test.ts` adds a static assertion that `McpServerConfig` type has no `rejectUnauthorized`/`insecure`/`skipTls` field, and that `McpServerRuntime` never passes such options to fetch/transport. Phase 4 `mcpServerFormLogic.test.ts` adds a UI test that no such field is rendered.

#### SHOULD-4 — `notifications/cancelled` payload may leak request args
- **Evidence:** Plan §Phase 6 line 278 propagates Stop/cancellation with `notifications/cancelled`. Spec/Plan do not specify the cancellation notification payload contents.
- **Impacted requirements:** FR-021, NFR-003.
- **Security consequence:** If the cancellation includes the original request args or a "reason" string with user-typed chat content, that data is sent to a server the user has just decided to interrupt — possibly because they distrust it.
- **Recommended plan change:** Phase 6 §Changes Required for `McpToolBridge.ts` must state: cancellation payload includes only `{ requestId, reason: "user_cancelled" }` (no args, no chat text). Add a `McpToolBridge.test.ts` row asserting the payload shape.

#### SHOULD-5 — 4 KB truncation constant inconsistent across plan and existing code
- **Evidence:** Plan §Phase 2 line 127 says "truncate displayed args at 4 KB". Existing `src\ui\ToolCallBlock.ts:199, 264` truncates at `4000` chars. Plan §Phase 5 line 238 says preamble instructions truncate "to 4096 chars per server". Spec uses both "4 KB" and "4096 chars".
- **Impacted requirements:** FR-030, FR-010.
- **Security consequence:** Inconsistent truncation across approval text and preamble means UTF-8 char counts vs. byte counts can diverge; an attacker crafting a 4 KB inject could land partially in some surfaces and fully in others, complicating audit of "what the user/model saw".
- **Recommended plan change:** Phase 2 / Phase 5 explicitly state "4096 UTF-16 code units" (matching JS `string.length`) and that approval, preamble, and rendered MCP args all use the same shared helper.

#### SHOULD-6 — Race between in-flight call and grant revocation is only addressed in Phase 6
- **Evidence:** Plan §Phase 4 line 202 says remove "stops disabled/removed servers". Plan §Phase 6 line 277 adds "in-flight rejection on disable/remove/reconnect". Phase 4 §Manual Verification SC-019 expects grants to clear on remove, but the test plan does not cover what happens when a user removes a server *while* one of its tools has been approved and dispatched but not yet returned.
- **Impacted requirements:** FR-012, FR-016, NFR-003.
- **Security consequence:** If Phase 4 ships before Phase 6, the window between Phase 4 and Phase 6 has an exploitable race: user removes server (UI says "tools cleared") but a recently-approved `tools/call` is still on the wire; the response/result is rendered without revalidation.
- **Recommended plan change:** Either restate the Phase Shippability Invariant to forbid shipping Phase 4 before Phase 6, or pull in-flight rejection on disable/remove from Phase 6 into Phase 4. Add a `main.mcpLifecycle.test.ts` case "remove server during in-flight tools/call rejects late result".

#### SHOULD-7 — Approval `resolvedApprovals` short-circuit in `AgentSession` not re-validated for the new MCP scope
- **Evidence:** `src\sdk\AgentSession.ts:1473-1486` short-circuits a re-asked permission with `{ kind: "approve-once" }` if the prior choice was anything other than `reject`. The plan extends `buildSafetyInput` but does not state that the short-circuit is safe for MCP when the underlying trust epoch may have changed between SDK calls in the same session.
- **Impacted requirements:** FR-012, FR-019.
- **Security consequence:** If the SDK re-emits `permissionRequested` for a `toolCallId` after the user has rotated trust (e.g., reconnect that bumped the session-only epoch), the cache returns `approve-once` even though the policy would now require approval.
- **Recommended plan change:** Phase 2 §Changes Required for `AgentSession.ts` adds: clear `resolvedApprovals` for an MCP tool when the corresponding server's trust epoch rotates or when the server transitions to disabled/disconnected/crashloop. Add `AgentSession.test.ts` row.

#### SHOULD-8 — `cwd` for stdio is the vault root by default; no validation prevents writing the per-server `cwd` outside the vault
- **Evidence:** Spec FR-004 says default `cwd` is vault root, overridable per server. Plan §Phase 3/4 do not specify validation of per-server `cwd` (existence, traversal, symlink resolution).
- **Impacted requirements:** FR-004, NFR-003.
- **Security consequence:** Low — `cwd` does not grant the child anything `command`/`args` couldn't already get to. But a non-existent `cwd` causes opaque spawn errors that may leak path info.
- **Recommended plan change:** Phase 4 `mcpServerFormLogic.ts` validates `cwd` (if set) exists at config save; runtime fails with a clear error rather than an opaque `ENOENT`.

---

### CONSIDER

- **CONSIDER-1:** Document the stable-id ↔ display-name distinction in the Settings UI itself (Phase 4) so users understand that renaming a server does *not* rotate trust but changing command/args/url does. Without this UX, the "trust epoch" behavior is invisible.
- **CONSIDER-2:** Surface a one-line "trust fingerprint" (short hash of `{command,args,url}`) in the Settings row so users notice unexpected mutations after config-file edits performed outside the UI.
- **CONSIDER-3:** Phase 6 `McpReconnectPolicy.ts` should require the *backoff timer itself* to be cancellable on disable/remove/unload; the plan says "manual Reconnect reset" but does not state that pending timer handles are explicitly cleared (only that "attempts are cancellable").
- **CONSIDER-4:** Phase 3 `McpServerRuntime` should set a stable `User-Agent` (e.g., `obsidian-copilot-agent/<version>`) so remote MCP operators can identify version-specific issues; today the plan is silent.
- **CONSIDER-5:** Phase 7 should record a security-posture summary (env denylist exact list, redaction list, SSRF host classes, redirect cap, payload caps, no-Undo invariant) in `Docs.md` so future reviewers have a single anchor.
- **CONSIDER-6:** Consider including a `redact.ts` round-trip test that takes a real `Error` object from a fake fetch with `Authorization` and `Mcp-Session-Id` headers and asserts neither the JSON-serialized error nor `error.stack` retains the secrets.

---

## Threat Model Notes

### Assets

| Asset | Sensitivity | Where stored / exposed |
|---|---|---|
| GitHub Copilot OAuth token / refresh token | High (account access) | `data.json` (separate store), v0.4 |
| User vault contents | High (private notes) | Filesystem under vault root |
| Static MCP `Authorization` header (user-pasted bearer) | Medium-High | `data.json` per server config |
| `mcpAutoApprove` grants | Medium (escalation surface) | `data.json` per `(serverId, toolName, trustEpoch)` |
| Ambient process env (`OPENAI_*`, `AWS_*`, `GITHUB_TOKEN`, etc.) | High | Parent Electron env, inheritable to stdio children |
| HTTP `Mcp-Session-Id` | Medium (replayable for session lifetime) | In-memory only; never persisted |
| Vault path / OS metadata (HOME, PATH) | Low-Medium | Available to stdio children by design |

### Trust boundaries

1. **User ↔ Plugin:** user trusts plugin code; plugin must not silently change trust.
2. **Plugin ↔ MCP server (stdio):** subprocess is untrusted code running with user's privileges. Bounded by: `shell: false`, env denylist, stdio JSON-RPC framing caps, lifecycle shutdown sequence, approval gate on every call.
3. **Plugin ↔ MCP server (HTTP):** remote untrusted code at a user-configured URL. Bounded by: HTTPS-only (except loopback), URL classification, redirect cap, cross-origin Authorization stripping, body/SSE caps, approval gate.
4. **MCP server output ↔ Model (Copilot):** server-supplied `instructions`, tool descriptions, and tool results flow into model context. Treated as untrusted; approval gate is the human-in-the-loop control.
5. **MCP server output ↔ UI:** server-supplied tool names, server names, args, results, stderr render into Obsidian UI. Treated as untrusted; safe-text rendering enforced.
6. **MCP server output ↔ Persistence:** Only the *user-supplied* config is persisted; server-supplied inventory/instructions/session-id are volatile.

### Primary threats

| # | Threat | Likelihood | Impact | Mitigation in plan |
|---|---|---|---|---|
| T1 | Malicious stdio server exfiltrates ambient secrets | Medium | High | FR-022 denylist, explicit env (gap: MUST-4) |
| T2 | Stdio command-injection via args (Windows `cmd`/cross-spawn) | Low | High | `shell: false` (gap: MUST-7) |
| T3 | SSRF via HTTP MCP URL to metadata / private host | Medium | High | FR-025 config-time classification (gap: MUST-1 redirect) |
| T4 | Cross-origin Authorization leak via redirect | Medium | High | Plan claims stripping (gap: MUST-1) |
| T5 | Synthetic-id spoofing via crafted `<tool-name>` | Low-Medium | Medium-High | Built-in collision check (gap: MUST-3) |
| T6 | Stale grant survives rename/repoint | Medium | Medium | Trust-epoch rotation, FR-012 (gap: MUST-6 lookup) |
| T7 | Prompt injection from server instructions / descriptions | High | Medium | Approval gate + truncation; user awareness gap: SHOULD-1 |
| T8 | XSS/UI-shape via stderr or last-error rendering | Low | Medium | textContent in approval; gap MUST-5 for stderr |
| T9 | Token/session-id leak into local diagnostics | Medium | High | redact.ts (gap: MUST-8 coverage) |
| T10 | DoS via oversized payloads / unbounded pagination | Medium | Medium | FR-008 / FR-028 caps in plan — covered |
| T11 | Stdio orphan/crashloop drains battery/CPU | Medium | Low-Medium | FR-018/FR-024 — covered |
| T12 | Race: grant revocation vs. in-flight call | Low-Medium | Medium | Partial (gap: SHOULD-6) |
| T13 | TLS verification bypass added later | Low | High | FR-025 (gap: SHOULD-3 negative test) |
| T14 | DNS rebinding to metadata after config save | Low | High | Deferred (gap: SHOULD-2 explicit) |
| T15 | Approval re-ask short-circuit auto-approves after trust rotation | Low | Medium | Existing AgentSession cache (gap: SHOULD-7) |

### Mitigations already well-planned

- Universal `decideSafety` routing with `source: "mcp"` and exact `(serverId, toolName, trustEpoch)` grants.
- `shell: false`, separate `command`/`args`, full-inherit-minus-denylist env.
- `Mcp-Session-Id` is never persisted; HTTP DELETE on clean shutdown.
- Stdio shutdown: stdin close → 5 s → SIGTERM → 5 s → SIGKILL, with idempotent unload.
- 16 MiB caps on JSON-RPC frame, HTTP body, and SSE accumulator; 64 KiB stderr ring buffer.
- Bounded `tools/list` pagination (50 pages / 1000 tools), 10 s initialize/page timeouts, 60 s default call timeout (cap 300 s).
- Approval prompt uses `textContent` (existing renderer) with 4000-char truncation.
- Phase ordering enforces safety gate before any transport can execute.

### Missing or under-specified mitigations

- Runtime enforcement of redirect cap and cross-origin Authorization stripping inside the SDK HTTP transport (MUST-1).
- Source-keyed Undo suppression at the renderer predicate (MUST-2).
- Synthetic-id parser hardening and tool-name normalization (MUST-3).
- UI warning when explicit env re-introduces denylisted keys (MUST-4).
- Safe rendering and control-character stripping for stderr surfacing (MUST-5).
- Synchronous trust-epoch lookup at decision time, with fail-closed on absence (MUST-6).
- Pinned SDK version and ownership of the spawn step (MUST-7).
- Redaction applied to SDK-thrown error messages and stack traces (MUST-8).
- Documented prompt-injection awareness (SHOULD-1).
- Explicit DNS-rebinding deferral note (SHOULD-2).
- Negative test for absence of `rejectUnauthorized: false` exposure (SHOULD-3).
- Bounded cancellation payload (SHOULD-4).
- Shared truncation constant across approval, preamble, and rendered args (SHOULD-5).
- Pull in-flight rejection into Phase 4 (SHOULD-6).
- Clear `resolvedApprovals` cache on epoch rotation (SHOULD-7).

---

## Anchor Check

| Anchor | Plan reference | Verified in src? | Notes |
|---|---|---|---|
| `src\domain\SafetyPolicy.ts` — `SafetySource = "mcp"`, `SafetyState.grantMcp`, `mcpAutoApprove`, `decideSafety` | Plan lines 17, 124, 432 | **Yes** | `SafetyPolicy.ts:19` (`SafetySource`), `:49` (`mcpAutoApprove?: Record<string, boolean>`), `:74` (`grantMcp(serverName: string)`), `:88` (`isMcpGranted(serverName)`), `:146` (`decideSafety(...)`), `:199-219` (mcp case). Plan correctly flags that current scope is server-name-only and must change. |
| `src\sdk\AgentSession.ts` — `buildSafetyInput`, MCP classification, `permissionRequested` routing | Plan lines 18, 125, 432 | **Yes** | `AgentSession.ts:1610` (`buildSafetyInput`), `:1630-1635` (mcp branch sets `source: "mcp"`, `toolName: request.serverName ?? toolName`), `:1722-1729` (`classifyToolSource`). Plan's plan to add `mcpServerId`/`mcpToolName`/`mcpTrustEpoch` inputs is consistent with current shape. |
| `src\ui\ToolCallBlock.ts` — Undo suppression / `shouldRenderUndoButton` | Plan lines 19, 128, 432 | **Yes** | `ToolCallBlock.ts:45-55` `shouldRenderUndoButton` exists. **Gap:** predicate has no `source` parameter; plan's "even if a caller mistakenly attaches an undoId" promise is unmet (see MUST-2). |
| `src\sdk\approvalText.ts` (plan line 127, "or existing approval helpers") | Plan line 127 | **Missing as a file**, exists as inline logic | No `approvalText.ts` exists. Approval rendering lives in `ToolCallBlock.ts:183-220` (`renderApprovalPrompt`) using `textContent` and `truncate(s, 4000)`. Plan acknowledges with "or existing approval helpers"; recommended to pick one and state it explicitly. |
| `src\domain\PreambleAssembler.ts` | Plan lines 20, 238 | **Yes** | File exists; extension for MCP inventory is consistent with current pattern. |
| `src\settings\SafetySettingsStore.ts` | Plan lines 21, 93, 432 | **Yes** | Exists; merge-and-write pattern present at `:201-219`. Plan's grant-evolution work is anchored correctly. |
| `src\settings\SettingsTab.ts` | Plan lines 21, 200, 432 | **Yes** | Exists; section-mounting pattern matches existing approach. |
| `src\main.ts` lifecycle | Plan lines 21, 94, 164, 202, 240, 279, 432 | **Yes** | `onload`/`onunload` present; deferred init pattern at `:577,:695-713`. Phase 3 plan to construct manager but no-op when empty is consistent. |
| `src\persistence\PersistedShape.ts` — sibling-preserving merge requirement | Plan line 22 | **Yes** | `:6-9` documents "Other top-level keys (`auth`, `safety`, `settings`) are owned by their respective stores and MUST be preserved on every write". MCP store must follow same pattern. |
| `src\domain\PermissionDecision.ts` (existing) | Not referenced | Exists | Plan does not list; might be worth checking whether MCP permission flow should re-use this type. |
| `src\mcp\*` (all new files) | Plan §§Phase 1-6 | **N/A** (new) | Naming pattern (`McpTypes.ts`, `McpIdentity.ts`, `McpManager.ts`, `McpServerRuntime.ts`, `McpToolRegistry.ts`, `McpToolBridge.ts`, `McpReconnectPolicy.ts`, `McpNotificationQueue.ts`, `stdioEnv.ts`, `httpPolicy.ts`, `redact.ts`, `normalizeMcpResult.ts`, `McpToolIdentity.ts`) is internally consistent. |
| `src\settings\McpSettingsStore.ts`, `mcpServerFormLogic.ts`, `McpServersSection.ts` | Plan §§Phase 1, 4 | **N/A** (new) | Locations under `src\settings` match existing convention. |
| `@modelcontextprotocol/sdk@1.29.0` pin | Plan lines 11, 158 | Unverified at runtime | Plan states version was rechecked with `npm view`; pinning policy (exact `1.29.0` vs `^1.29.0`) is not specified — recommend exact pin per MUST-7. |

**Security-sensitive anchors missing or under-specified:**
- No file owns the runtime hop-by-hop redirect / Authorization-strip enforcement (MUST-1).
- No file owns universal redaction-at-write-site for `lastError` and `console.log/error` paths (MUST-8); `redact.ts` exists but the call-sites that must use it are not enumerated.
- `McpToolIdentity.ts` is named but the parser/normalization spec is absent (MUST-3).
- `shouldRenderUndoButton` is named but the source-keyed guard is absent (MUST-2).
