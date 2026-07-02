# WorkflowContext

Work Title: MCP Readiness UX
Work ID: mcp-readiness-ux
Base Branch: main
Target Branch: feature/mcp-readiness-ux
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: single-model
Final Review Interactive: smart
Final Review Models: none
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: single-model
Plan Generation Models: none
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
Initial Prompt: |
  Address three follow-ups from v0.8.0 that all touch the MCP readiness
  subsystem:

  1. **Readiness indicator.** While `McpManager.waitUntilEnabledReady`
     is pending after adding a server + starting a new chat, the
     composer sits silently disabled. Surface a "Preparing MCP tools…"
     status (pill/notice/spinner — TBD in spec) so users understand
     what's happening. See `src/mcp/McpManager.ts:268-313` and
     `src/ui/ChatView.ts:685-698, 1082-1093`.

  2. **Slow-server retry/refresh.** Servers doing interactive auth
     (workiq, agency-mail, `az login` / device flow) can take longer
     than the current 15s readiness ceiling. When the gate times out,
     the session is created without those servers' tools and users
     must reload the plugin to pick them up. We need a retry / refresh
     path that lets a late-arriving server's tools become usable in
     the live session — no plugin reload required.

  3. **SDK `updateTools()` upstream (proposal 0009).** The mechanism
     that makes (2) possible: add `session.updateTools()` (or
     equivalent) to the Copilot SDK so tool-list changes can be
     pushed into a live agent session. This is the upstream fix that
     replaces the current "reload to refresh tools" workaround, and
     it is the substrate for the retry/refresh flow in (2).

  Scope: plugin-side plumbing (McpManager gate + ChatView status +
  session refresh) and, if feasible, an SDK PR for `updateTools`. If
  the SDK change is out of reach in this workflow, land a plugin-side
  shim and file the SDK proposal as the follow-up.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
