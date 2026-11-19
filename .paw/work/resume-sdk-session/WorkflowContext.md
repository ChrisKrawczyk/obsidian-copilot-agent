# WorkflowContext

Work Title: Resume SDK Sessions Across Restarts
Work ID: resume-sdk-session
Base Branch: main
Target Branch: fix/resume-sdk-session
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@53f94bb5570a26d7cf0ad1d0062e38d7ab37e1dc
Execution Binding: none
Workflow Mode: custom
Review Strategy: local
Review Policy: final-pr-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-6.2-sol, gemini-4-argon, claude-opus-5.5
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
Planning Review Models: gpt-6.2-sol, gemini-4-argon, claude-opus-5.5
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: PAW Lite (Plan -> Implement -> Review -> PR). Skip work shaping.
Initial Prompt: Session history is not sticky across Obsidian restarts/reloads. The transcript re-renders in the chat pane but the agent has no memory of it, because every conversation runtime calls client.createSession() and never persists or resumes the SDK session id. Persist the SDK session id per conversation, resume it via client.resumeSession() on activation, fall back sensibly when no resumable session exists (decided by multi-model debate), and delete the SDK session when its conversation is deleted.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
