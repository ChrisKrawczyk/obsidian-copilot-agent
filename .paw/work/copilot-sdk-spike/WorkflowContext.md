# WorkflowContext

Work Title: Copilot SDK Spike
Work ID: copilot-sdk-spike
Base Branch: main
Target Branch: feature/copilot-sdk-spike
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
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
Plan Generation Mode: single-model
Plan Generation Models: claude-opus-4.7
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
Initial Prompt: Create a minimal Obsidian plugin that loads `@github/copilot-sdk`, opens a session with a GitHub PAT (or token from secure storage), and prints a "hello" response from a model into an Obsidian Notice. Goal: confirm the SDK runs cleanly inside an Obsidian plugin sandbox on desktop. Use `logancyang/obsidian-copilot` as a structural reference for plugin scaffolding only — no code copying (it is AGPL-3.0). Desktop-only (`isDesktopOnly: true`).
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
