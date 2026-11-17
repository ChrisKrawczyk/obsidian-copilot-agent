# WorkflowContext

Work Title: SDK setTools Adoption
Work ID: sdk-settools-adoption
Base Branch: main
Target Branch: feature/sdk-settools-adoption
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: custom
Review Strategy: local
Review Policy: final-pr-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-6.1-sol, gemini-4-argon, claude-opus-5.5
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: single-model
Plan Generation Models: none
Planning Docs Review: disabled
Planning Review Mode: multi-model
Planning Review Interactive: smart
Planning Review Models: gpt-6.1-sol, gemini-4-argon, claude-opus-5.5
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: PAW Lite (Plan -> Implement -> Review -> PR). Skip work shaping.
Initial Prompt: Adopt the experimental session.setTools() primitive from @github/copilot-sdk >=1.0.17 (resolution of github/copilot-sdk#1896; repo is on 1.0.34) for live mid-session tool-list updates. AgentSession currently probes for a non-existent `updateTools` and falls back to a session-swap stop-gap (swapSessionForToolRefresh via resumeSession). Switch the probe/call to setTools, guard against the empty-list semantics (empty list removes all client tools), retire the session-swap fallback and its tests, and update docs referencing #1896 / proposal 0003.
Issue URL: https://github.com/github/copilot-sdk/issues/1896
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
