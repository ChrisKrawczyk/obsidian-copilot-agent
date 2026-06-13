# WorkflowContext

Work Title: MCP Client Integration
Work ID: mcp-client
Base Branch: main
Target Branch: feature/mcp-client
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
Initial Prompt: v0.5 of obsidian-copilot-agent. Adds **MCP client** integration so the agent can connect to external Model Context Protocol servers and surface their tools alongside the existing built-in vault tools.

**Goals:**

1. **Connect to MCP servers** over both `stdio` (spawned child process) and `http` (remote, including streamable HTTP per the MCP spec) transports. Configuration is per-server, persisted across plugin reloads.

2. **Tool surfacing.** Each connected MCP server's tools register into the agent's existing tool gating + approval surface (universal permission gate). MCP tools are mutating-by-default — every call goes through the same approval prompt as v0.1 raw-FS / v0.2 vault-mutating tools, unless the user explicitly auto-approves a specific server or tool via the existing safety allowlist mechanics.

3. **Configuration UI.** Settings → Copilot Agent → MCP Servers: add/remove server entries (name, transport, command + args for stdio OR url + headers for http), enable/disable toggle per server, last-error display, and a "Reconnect" affordance. No live discovery / registry browsing in v0.5 — manual JSON-style entry only.

4. **Credentials.** For HTTP MCP servers that require auth, support a static `Authorization` header value entered at server-add time (we do NOT implement OAuth flow for MCP servers in v0.5 — token paste only). Stored alongside other safety/auth state, not in plain JSON if the platform offers a safer store (best-effort only — same posture as v0.3 token storage).

5. **Tool inventory in the preamble.** When the vault-aware preamble runs, MCP tools appear in the inventory with a clear `(MCP / <server-name>)` suffix so the model knows the source. Auth conventions and permission semantics carry over from v0.2.

6. **Resilience.** MCP server crashes / disconnects do NOT crash the agent. Failed `tools/call` results are surfaced as tool-call errors (the existing tool-call block UI). Reconnect is available manually; auto-reconnect with exponential backoff for stdio is in scope; for http the next call attempts a fresh connect.

**Constraints carried from v0.4:**

- All MCP tool calls route through the existing universal permission gate.
- Maintain 724/724 baseline test coverage; add tests for transport, registration, gating, and resilience.
- No regression to streaming, Stop control, approval-prompt flow, token rotation, multi-conversation soft-cap / archive flow, the Undo journal, raw-FS gating, the vault-aware preamble, the v0.4 model picker / catalog / recovery paths, lazy modelId resolution, deferred-init recovery, or send-gate precedence.
- README + Docs.md updated as items ship.

**Out of scope (deferred to a future workflow):**

- Acting as an MCP server (exposing the plugin's vault tools to other MCP clients).
- OAuth flow for MCP servers (only static Authorization header in v0.5).
- MCP resource / prompt features (only `tools/list` + `tools/call` in v0.5; resources/prompts deferred).
- Sampling (server-initiated LLM calls back to the agent's model).
- A registry / browser of public MCP servers — manual entry only in v0.5.
- Live tool-list refresh while a tool is mid-stream — refresh happens on (re)connect.
- Per-conversation MCP server allowlist; v0.5 is global ("connected = visible to every conversation").
- Telemetry / cost accounting for MCP tool usage.

Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
