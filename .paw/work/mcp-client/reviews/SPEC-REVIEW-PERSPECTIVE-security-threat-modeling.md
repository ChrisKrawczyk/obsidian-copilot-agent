# Spec Review — Security / Threat-Modeling Perspective

- **Specialist:** Security & Threat-Modeling Reviewer
- **Artifact under review:** `.paw\work\mcp-client\Spec.md` (v0.5 MCP Client Integration)
- **Supporting docs:** `.paw\work\mcp-client\SpecResearch.md`, `.paw\work\mcp-client\WorkflowContext.md`
- **Review scope:** Security posture only. Functional/UX/perf concerns flagged only when they create attack surface or testability gaps for security review.
- **Verdict:** **NEEDS-REVISION**

The spec is materially better than the v0.4 baseline on threat awareness (env denylist, TLS posture, untrusted-annotations rule, stdin→SIGTERM→SIGKILL shutdown, never-persist `Mcp-Session-Id`). However, several security-relevant requirements are either ambiguous, missing, or untestable. None of the gaps require a redesign — they can be closed by tightening acceptance criteria, adding small new requirements, or splitting an existing requirement. I therefore flag this as NEEDS-REVISION rather than BLOCKED.

The remainder of this document lists findings by severity, with evidence (line numbers in `Spec.md` and `SpecResearch.md`) and a *direction* for the spec author. Per review protocol, I do not propose rewritten spec text.

---

## Must-fix findings (block implementation until addressed)

### MUST-1 — Stdio spawn semantics: no requirement that `shell: false` / no shell interpolation
- **Evidence:** `Spec.md:51-53` (FR-004) only says "Configured command/args/cwd are used as displayed" and "Windows users can configure `cmd /c npx ...`"; `SpecResearch.md:472` notes the SDK uses `cross-spawn` (which can invoke a shell when `shell: true`). Nothing in the spec forbids `shell: true` or shell-string forms of `command`.
- **Threat:** A future implementation (or a regression) could pass a single shell-line to `cross-spawn` with `shell: true`, turning user-pasted `command` strings into shell expressions and re-introducing argument-injection (e.g. `"; rm -rf …"`) that is hard to audit. The current FR-004 acceptance criterion ("used as displayed") is *not* equivalent to "no shell interpolation".
- **Direction:** Add an acceptance criterion to FR-004 mandating that stdio launches MUST execute with shell interpolation disabled (no `shell: true`, no implicit `/bin/sh -c`), MUST take `command` and `args[]` as separate values without further parsing, and that the documented Windows escape hatch is the *user-supplied* `cmd /c` pattern (i.e. the user passes `cmd` as `command` and `/c npx …` as `args`), not an automatic shell wrap inserted by the plugin. Make this independently testable.

### MUST-2 — Env denylist omits well-known cloud / LLM provider secrets
- **Evidence:** `Spec.md:141-143` (FR-022) names only `GITHUB_TOKEN`, `COPILOT_*`, `COPILOT_AGENT_*`, and "plugin-owned" auth/session keys. `SpecResearch.md:580-585` explicitly calls out `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, etc. as common secrets in a developer's environment, none of which are plugin-owned.
- **Threat:** A user installs a malicious or compromised MCP server (npm package, hostile fork). The subprocess inherits the user's shell environment. Even though the plugin has no business with these credentials, the subprocess can read and exfiltrate them. The denylist as written is the only protection and it is incomplete by design.
- **Direction:** FR-022 should require the denylist to include (a) plugin-owned keys (already covered), (b) a documented set of well-known cloud / AI provider credential keys and prefixes (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`, `AZURE_*`, `GCP_*`, `OPENAI_*`, `ANTHROPIC_*`, `HUGGINGFACE_*`, `GOOGLE_APPLICATION_CREDENTIALS`, etc.), with the explicit list and matching rules captured in the spec so they are testable. Make the denylist policy *additive* per-server (user can re-add a specific var via explicit `env`, but cannot opt out of the global denylist). Acknowledge in the spec that allow-listing would be safer than deny-listing and document the deliberate trade-off.

### MUST-3 — No size/time bounds on subprocess stdout, stderr, or HTTP responses (DoS / OOM)
- **Evidence:** FR-004 (`Spec.md:51-53`) says "stderr is captured only for diagnostics" but sets no cap. FR-014 (`Spec.md:101-103`) defers text result size to "existing truncation behavior" without stating what that is for MCP. There is no per-line cap on the newline-delimited JSON-RPC framing (`SpecResearch.md:252-253`), no max HTTP response body size, no per-request timeout on `tools/call`, and no upper bound on `tools/list` total tool count or page count (FR-008, `Spec.md:70-73`).
- **Threat:** A misbehaving or hostile server can (a) emit a single multi-GB JSON line and OOM the renderer; (b) flood stderr until the diagnostic buffer consumes all RAM; (c) return a multi-GB tool result; (d) advertise an effectively unbounded paginated tool list, exhausting memory before pagination terminates; (e) accept `tools/call` and never respond, hanging the UI until the user manually clicks Stop. Each is reachable with no privileged access — only the standard MCP tool surface.
- **Direction:** Add explicit, testable bounds:
  - JSON-RPC line / frame max size (e.g. small number of MB), exceed → connection treated as protocol error.
  - Stderr ring buffer max size (per process), with oldest-discard semantics.
  - `tools/call` default request timeout (with a clear behaviour when exceeded — surface as tool error, send `notifications/cancelled`).
  - Maximum page count and/or maximum total tool count for `tools/list`; exceed → inventory marked unavailable with last error.
  - Maximum HTTP response body size for both unary responses and SSE streams (or chunk count cap). State whether streaming results stop accumulating after the cap.

### MUST-4 — SSRF / private-IP / metadata-service exposure for HTTP transport
- **Evidence:** FR-025 (`Spec.md:155-158`) only requires HTTPS validation and a warning for non-localhost HTTP. `SpecResearch.md:625-630` explicitly identifies SSRF risk, including the AWS/Azure metadata endpoint `169.254.169.254`. The current spec does not require any guard against private/RFC1918/link-local/metadata IPs even when scheme is `https`.
- **Threat:** An attacker (or a malicious config snippet copy-pasted from the web) sets a remote MCP URL of `https://169.254.169.254/…` or `https://10.0.0.5/…` and uses the user's static `Authorization` header to fan out into internal services. HTTPS does not block this; certificate validation against an internal cert is also possible. The plugin becomes an SSRF stepping stone.
- **Direction:** FR-025 should require URL validation that classifies the host:
  - Public DNS / public IP: allowed.
  - Loopback / `localhost`: allowed.
  - Private (RFC1918), link-local (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), `metadata.google.internal`, `*.svc.cluster.local`: blocked or require an explicit, opt-in confirmation that is recorded with the server config (so it shows in the UI and is auditable).
  - Optional: re-resolve at connect time to defeat trivial DNS rebinding. State this explicitly even if deferred to a later release.

### MUST-5 — `Authorization` header behaviour on HTTP redirects is unspecified
- **Evidence:** FR-003 (`Spec.md:46-48`) and FR-025 (`Spec.md:155-158`) say nothing about redirect handling.
- **Threat:** A 301/302/307 from the configured MCP host to an attacker-controlled host can cause the static bearer token to be replayed cross-origin, leaking the credential. This is a classic credential-leak-on-redirect.
- **Direction:** FR-005 / FR-025 should require that the HTTP transport either (a) does not follow redirects at all (treat as protocol error), or (b) follows redirects only to the same origin and strips `Authorization` on cross-origin redirects. State the chosen behaviour as a testable acceptance criterion.

### MUST-6 — Auto-approve allowlist keyed by mutable display name, not stable id
- **Evidence:** FR-001 (`Spec.md:36-38`) defines `id` as the stable identifier; FR-012 (`Spec.md:90-93`) keys auto-approval as `mcpAutoApprove[serverName]`. The user can edit `name` from Settings (FR-002, `Spec.md:40-43`).
- **Threat:** Two attack/misuse paths. (a) User grants auto-approve to server "fs-readonly", later renames it to "fs-full-rw" — the grant silently follows, even though the user perceives this as a new server. (b) User removes server "fs", later adds an unrelated server with the same name — the dormant grant silently re-applies. Either path lets the next call execute without prompting under a false identity.
- **Direction:** FR-012 should require auto-approve to be keyed by the stable server `id` (or by a server identity token bound to `{id, transport, command|url}`). Renaming a server MUST NOT carry forward the auto-approve grant unless the underlying identity is unchanged. Removal MUST clear the grant. Make this independently testable.

### MUST-7 — Cross-server / built-in tool name collision and source spoofing
- **Evidence:** FR-008 (`Spec.md:70-73`) handles only intra-server duplicates. FR-009 (`Spec.md:75-78`) says "Registered tool identity is globally unambiguous and preserves server attribution" but does not specify *how*. FR-010 (`Spec.md:80-83`) places attribution in the preamble. The user-supplied `name` in FR-002 has no normalization rules.
- **Threat:** (a) A malicious MCP server registers a tool named `read_file`, `write_file`, `delete`, etc., colliding with built-in vault tool names. If the SDK keys tools by bare name, the agent may dispatch built-in calls to the MCP server (or vice versa). (b) A user names a server `vault` so the preamble shows `(MCP / vault)` and the LLM (or a casual reader of the approval prompt) confuses MCP tools with the built-in vault surface. (c) Two MCP servers each expose a tool named `search`; without namespacing, the SDK cannot route deterministically.
- **Direction:** Specify a concrete namespacing scheme that is exposed to the SDK and to the LLM (for example, "MCP tool identity is `mcp__<serverId>__<toolName>` and the registered SDK tool name uses this form; bare names are never exposed to the dispatcher"). Require server `name` to be normalised and reject names that collide with built-in tool sources (`vault`, `web`, etc.). Make both rules testable in `src\sdk\AgentSession.test.ts` (per FR-009 test hooks).

### MUST-8 — `Mcp-Session-Id` leakage via last-error / logs is not prohibited
- **Evidence:** FR-019 (`Spec.md:125-128`) requires the session id never persist in `data.json`, but does not address last-error UI text, stderr buffers (FR-004), or any future log surface (NFR-008, `Spec.md:174`).
- **Threat:** The plugin renders last-error strings in the UI and captures stderr "for diagnostics". If the SDK's error formatter includes the session id (it has, historically, in similar SDKs), the id is rendered into a UI string that the user can screenshot, paste, or sync. Session ids are short-lived but are the only secret on the wire after the static token, so this is non-trivial.
- **Direction:** FR-019 should add an acceptance criterion that `Mcp-Session-Id` MUST NOT appear in any rendered error, status, log snippet, or stderr capture; redaction is required. Reuse the existing token-redaction posture if one exists.

---

## Should-fix findings (close before final spec sign-off)

### SHOULD-1 — `cwd` default is unspecified and not threat-modeled
- **Evidence:** FR-001 stores optional `cwd` (`Spec.md:36-38`); FR-004 says nothing about the default when omitted. `SpecResearch.md:590-593` notes cwd defaults to "plugin process CWD (unspecified)".
- **Threat:** If unset cwd resolves to the Obsidian process working directory or the vault root, the subprocess inherits a privileged FS context (vault contents, plugin secrets directory). A vulnerable server resolving relative paths can then read/write inside the vault.
- **Direction:** Specify a deterministic, isolated default (e.g. the user's home directory or an explicit per-server scratch dir). Forbid the plugin's own config/secret directory as default. Add a test hook for this default.

### SHOULD-2 — FR-008 dedup policy is "rejected OR de-duplicated" — ambiguous and untestable
- **Evidence:** `Spec.md:72` "duplicate tool names within a server are rejected or deterministically de-duplicated with visible error".
- **Threat:** Two implementations could both be conformant yet have different security properties (silent dedup hides a malicious shadow-tool; rejection is loud and auditable). Tests cannot pin down a single behaviour.
- **Direction:** Pick one. From a security posture, "reject the entire inventory and surface as last error" is preferable because it makes the conflict observable.

### SHOULD-3 — FR-018 stdio auto-reconnect bounds are not specified
- **Evidence:** `Spec.md:120-123` says "bounded exponential-backoff" and "repeated failure never blocks chat UI" but states no concrete bounds.
- **Threat:** A server that crashes immediately on start (e.g. malformed config, deliberate denial) creates a tight reconnect loop that can saturate CPU, fill stderr, and wear out an attacker-favourable spawn-and-die cycle. "Bounded" without numbers is not testable.
- **Direction:** Specify max attempts per session, max delay cap, jitter, and reset condition (e.g. 1 successful initialize resets the counter). Make at least the upper-bound behaviour testable.

### SHOULD-4 — FR-025 "explicit warning/confirmation" for non-localhost HTTP is not defined
- **Evidence:** `Spec.md:157` "HTTP is allowed only for localhost/loopback or requires explicit warning/confirmation".
- **Threat:** Vagueness defeats the security control. A `console.warn()` is a "warning" and yields zero user-visible signal.
- **Direction:** Define the user-visible artifact (modal, persistent banner, settings-row badge) and require it to be sticky (not just at add time) for any plaintext HTTP server.

### SHOULD-5 — Server `instructions` and tool `description` are concatenated into the preamble without isolation
- **Evidence:** FR-010 (`Spec.md:80-83`) truncates instructions to 4 KB but does not require any structural isolation in the preamble. `SpecResearch.md:646-660` flags both annotation untrustworthiness and prompt-injection-via-results.
- **Threat:** Untrusted MCP servers control prompt-injectable strings (instructions, tool descriptions, tool result text). Concatenated raw into the system/preamble, these can subvert the agent. The approval gate is the primary control, but only for *calls*, not for the model's reasoning that is steered before any call is proposed.
- **Direction:** Require the preamble assembler to wrap each per-server instructions/description block in an explicit, labeled, untrusted-content delimiter (the spec does not need to dictate the exact tokens, but it should require *some* convention and forbid raw concatenation). State that this is mitigation-only and that the approval gate remains the security boundary. Make the wrapping testable in `src\domain` preamble tests.

### SHOULD-6 — Approval-prompt rendering safety is not specified
- **Evidence:** FR-011 (`Spec.md:85-88`) says the prompt "shows server/tool/args"; nothing about safe rendering.
- **Threat:** If the approval prompt renders Markdown or HTML from `args`, a crafted argument string ("Click [yes](javascript:approve())", or text designed to confuse the user about which tool is being run) becomes a UX-level injection. The user can be tricked into approving the wrong call.
- **Direction:** Require args / tool name / server name to render as plain text only in the approval UI (no Markdown, no link rendering, no HTML) and to truncate at a stated length with a "view raw" affordance. Add a corresponding UI test.

### SHOULD-7 — Audit / forensic logging of MCP invocations is not required
- **Evidence:** NFR-008 (`Spec.md:174`) explicitly says "no telemetry/cost accounting is added" but says nothing about *local* audit logging of MCP tool calls.
- **Threat:** When an auto-approved server later behaves badly, there is no after-the-fact record of *which* calls ran, with what args, and what they returned. This is the single most-asked-for artifact in incident response for tool-use systems.
- **Direction:** Require a local, append-only log (or in-memory ring buffer with on-disk overflow) of: timestamp, serverId, tool name, arg summary (size-bounded), approval decision (auto / per-call / session), success/error. Out of telemetry scope (data stays local). Acknowledge in NFR-008.

### SHOULD-8 — Header redaction lacks reveal/edit safeguards
- **Evidence:** FR-003 (`Spec.md:46-48`) says "saved value is redacted in the UI except explicit edit/reveal".
- **Threat:** "Reveal" without further controls (hover, click-to-copy, auto-hide) can casually expose tokens to shoulder-surfing and to screen-recorded support sessions. Multi-tenant machines amplify this.
- **Direction:** Specify that reveal is momentary (auto-hide after N seconds), requires an explicit click, and that copy-to-clipboard is a separate explicit action. Forbid the value being placed in the DOM in plaintext at any time other than the active reveal window.

### SHOULD-9 — `data.json` is the only credential store, no warning about Obsidian Sync / iCloud propagation
- **Evidence:** FR-001 + FR-003 (`Spec.md:36-48`) store the Authorization header in `data.json`. `SpecResearch.md:622` flags vault-sync exposure risk explicitly.
- **Threat:** Users with Obsidian Sync, iCloud Drive, or Git-synced vaults will replicate plaintext bearer tokens to all of their devices and any backup tier.
- **Direction:** Require an explicit user-facing warning at server-add time when an `Authorization` header is entered, and add a top-level paragraph to the spec documenting that storage posture matches v0.3 token storage. State whether plugin-data exclusions (e.g. `.obsidian/plugins/.../data.json` not synced) are relied on, and if not, require a UI advisory.

---

## Consider findings (lower priority, capture as known limitations or follow-ups)

### CONSIDER-1 — Spec is silent on Linux PATH amendment policy
- **Evidence:** FR-023 (`Spec.md:145-148`) addresses only macOS PATH amendment; SpecResearch §5.1 only discusses macOS and Windows.
- **Direction:** State explicitly that Linux launches inherit `PATH` unchanged (subject to env filtering) so the absence is a deliberate decision and not an oversight.

### CONSIDER-2 — No upper bound on number of configured MCP servers
- **Evidence:** FR-001/FR-002 impose no cap.
- **Direction:** Either set a soft cap (e.g. 32) with a settings warning beyond it, or explicitly state "no cap, user-administered".

### CONSIDER-3 — `/usr/local/bin` and `/opt/homebrew/bin` may be group-writable on shared machines
- **Evidence:** FR-023 prepends both unconditionally.
- **Direction:** Acknowledge the trust assumption (these paths are equivalent in trust to the user's shell) and document that the absolute-path escape hatch (FR-023 ac) is the recommended posture for higher-assurance setups.

### CONSIDER-4 — Sandbox / OS-level isolation for stdio servers is not mentioned
- **Evidence:** Not present. SpecResearch §6.2 notes VS Code's macOS/Linux sandbox option as out of scope for Obsidian.
- **Direction:** Note explicitly as a non-goal for v0.5 and a candidate for a future hardening release. Useful context for the threat model.

### CONSIDER-5 — `notifications/cancelled` is "SHOULD" not "MUST"
- **Evidence:** FR-021 (`Spec.md:135-138`).
- **Direction:** Acceptable as-is for v0.5, but worth noting that without reliable cancellation, a server can keep working on an authorised-then-stopped operation. State this as an accepted residual risk.

### CONSIDER-6 — Plugin unload race for in-flight MCP calls
- **Evidence:** FR-024 covers process shutdown but not in-flight `tools/call` rejection.
- **Direction:** State that pending MCP calls MUST settle (rejected with cancellation reason) before subprocess kill, so no UI promise is left hanging across a reload.

---

## Cross-cutting observations on spec testability

- The acceptance criteria are generally good security inputs (clear, mostly observable). The exceptions are FR-008's "rejected or de-duplicated", FR-018's "bounded exponential-backoff" without numbers, FR-025's "explicit warning/confirmation", and FR-022's "plugin-owned auth/session env keys such as any process-env representation of the in-memory GitHub token" — the last reads more as guidance than as a spec; a security reviewer needs a concrete enumerated denylist.
- Several requirements that are *necessary for security* (MUST-1, MUST-3, MUST-4, MUST-5, MUST-7) are currently inferable from intent but not stated. A future implementer satisfying every literal AC could still ship vulnerable code. Closing the must-fix list above resolves this.

## Suggested direction (do not rewrite spec — high-level only)

1. Add a short "Security" subsection (between Non-Goals and Functional Requirements) that enumerates the threat model assumptions: (i) MCP server code is untrusted; (ii) MCP server outputs (instructions, descriptions, results, annotations) are untrusted content for the model; (iii) the approval gate is the security boundary for execution; (iv) the env denylist + cwd default + bounded I/O are the security boundary for the subprocess; (v) HTTPS validation + URL classification + redirect policy are the security boundary for remote transports; (vi) `data.json` plaintext is the documented storage posture, not a hardened secret store.
2. Tighten the FRs called out in MUST-1 through MUST-8 with the additional acceptance criteria suggested above. Each addition is small and independently testable.
3. Add the bounded-I/O requirements (line size, response size, request timeout, page count) as a dedicated FR — they currently scatter across FR-004, FR-008, FR-014 and will be missed.
4. Fold the audit-log requirement (SHOULD-7) into NFR-008 as a clarification ("no remote telemetry; local invocation log is required").
5. Rename / re-key auto-approve to `id`-based mapping in FR-001 + FR-012 so storage and behaviour agree.

---

## Verdict rationale

The spec demonstrates clear awareness of the high-level threats (untrusted servers, env leakage, untrusted annotations, orphan processes, TLS posture). What is missing is the second-order detail that a security reviewer cannot infer from intent: shell-disable on spawn, complete denylist, bounded I/O, redirect handling, SSRF guard, stable-id auto-approve, namespaced tool identity, and session-id redaction. These are correctable inside the existing structure. **NEEDS-REVISION**.
