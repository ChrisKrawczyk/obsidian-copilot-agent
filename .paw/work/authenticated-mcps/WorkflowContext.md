# WorkflowContext

Work Title: Authenticated MCPs
Work ID: authenticated-mcps
Base Branch: main
Target Branch: feature/authenticated-mcps
Execution Mode: current-checkout
Repository Identity: none
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: multi-model
Plan Generation Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Docs Review: enabled
Planning Review Mode: multi-model
Planning Review Interactive: smart
Planning Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: none
Initial Prompt: Add support for **authenticated MCP servers** to the Obsidian Copilot Agent plugin, with **Microsoft 365 Graph MCP** as the marquee first-party preset. Generalize the existing MCP server configuration so any HTTP MCP server that needs an `Authorization` header can be configured against either a static bearer token (A1) or a **command-based credential** that the plugin re-executes on a refresh window (A2). Design the credential model as a discriminated union so a future OAuth 2.1 + PKCE variant (B) is purely additive.

**Confirmed by spike (recorded in summary, June 19 2026 session):**

- Endpoint: `https://mcp.svc.cloud.microsoft/enterprise` (Streamable HTTP).
- Server appId: `e8c77dc2-69b3-43f4-bc51-3213c9d915b4`.
- `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json` returns a token whose `aud` matches the MCP server appId and whose `scp` includes the `MCP.*` delegated scopes.
- Protocol `initialize` + `tools/list` succeed end-to-end. Server identifies as `Microsoft.Entra.MCP v1.0.3453.223`. Three tools available: `microsoft_graph_suggest_queries`, `microsoft_graph_get`, `microsoft_graph_list_properties`.
- Protocol version `2025-06-18` (matches our SDK).

**Phase 1 — Polymorphic MCP server credentials**

1. New `src/mcp/credentials/` module with discriminated-union type:
   ```ts
   type ServerCredentials =
     | { kind: "none" }
     | { kind: "static-bearer"; token: string }
     | { kind: "command-based"; command: string; args?: string[]; tokenJsonPath?: string; expiresAtJsonPath?: string; refreshBufferSec?: number };
   // Future: | { kind: "oauth-pkce"; ... }
   ```
2. `CredentialsResolver` interface — returns `{ headerValue, expiresAt }`. Each variant has its own resolver implementation. Token cache keyed by server id, invalidated on `expiresAt - refreshBuffer`.
3. Command-based variant runs the configured command through the existing process-spawn primitive (`StdioTransport.findOnPath` style on Windows; `child_process.spawn` cross-platform), parses stdout JSON, extracts `accessToken` + `expiresOn` via configurable JSON path (defaults `accessToken` / `expiresOn`, matching `az`).
4. Security: secrets never logged. Static-bearer tokens stored via the existing settings encryption helper. Command path resolved per-OS and never invoked with shell interpolation of vault-controlled strings.

**Phase 2 — HTTP MCP transport integration**

5. Wire `CredentialsResolver` into the HTTP MCP transport so every outbound request stamps `Authorization: <headerValue>` when credentials are configured.
6. On HTTP `401` from the server, invalidate the credential cache, re-resolve once, retry; if the second attempt still 401s, surface as a "credentials rejected" error to the chat (with a Settings deep-link).
7. Honor existing `httpPolicy` guardrails (redirect, private IP, allowlist).
8. Telemetry-free: log refresh counts only at debug level; never log token values or their substrings.

**Phase 3 — Settings UI + first-party preset**

9. `McpServersSection.ts` gets a "Credentials" subsection on each HTTP server form: variant picker, conditional fields per variant, masked-by-default token input for A1, `Test connection` button (issues `initialize` + masks the body).
10. Built-in preset: **"Microsoft 365 Graph (via Azure CLI)"** — pre-fills URL `https://mcp.svc.cloud.microsoft/enterprise`, transport `http`, credentials `command-based` with command `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json`, refresh buffer 300s.
11. Trust epoch: a credential refresh is NOT a server-identity change. Existing approval grants survive token rotation. Document this explicitly in the SafetyPolicy notes.
12. Forward-compat slot: settings schema reserves an `oauth: { clientId, tenantId, scopes }` shape that's UI-hidden today but reads/writes cleanly so a future Phase B is data-compatible.

**Phase 4 — Docs + smoke verification**

13. New `docs/m365-graph-mcp.md` walking through: one-time `az login`, applying the preset, the `Grant-EntraBetaMCPServerPermission -ApplicationName VisualStudioCode` tenant-admin prerequisite, and how to verify in the chat.
14. README "MCP servers" section adds a callout linking to the new doc.
15. Manual smoke checklist in `.paw/work/authenticated-mcps/SmokeChecklist.md`: preset apply → token resolves → initialize succeeds → at least one Graph tool call returns user-identity-grounded data → token survives a refresh boundary.

**Constraints:**

- Existing 970+ tests must stay green. New modules ship with unit tests (resolver variants, expiry math, JSON path extraction, 401-retry logic). UI tests stay DOM-free per `copilot-instructions.md`.
- No regression to existing stdio MCP servers (Foam, OneDrive). The credentials layer is opt-in per server.
- No network traffic in unit tests. The HTTP-transport integration test uses a local mock that replays a known token contract.
- `copilot.exe` packaging unchanged; this work touches only TypeScript + settings UI.

**Out of scope (deferred):**

- OAuth 2.1 + PKCE in-plugin flow (Phase B from the design discussion). The discriminated-union design preserves the slot.
- Custom Entra app registration UX. Documented as a user-side prerequisite only.
- ID-JAG / enterprise-managed SSO. Out of scope until B lands.
- Non-Microsoft authenticated MCPs as built-in presets (the framework supports them, but only the M365 preset ships in this workflow).
- Auto-detection of installed CLIs (`az`, `gh`, etc.) in the settings UI — manual config only this round.

Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
