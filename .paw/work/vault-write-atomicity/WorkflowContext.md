# WorkflowContext

Work Title: Vault Write Atomicity
Work ID: vault-write-atomicity
Base Branch: main
Target Branch: feature/vault-write-atomicity
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: planning-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-5.5, gemini-3.1-pro-preview, claude-opus-4.8
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
Planning Review Models: gpt-5.5, gemini-3.1-pro-preview, claude-opus-4.8
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: none
Initial Prompt: Fix lost-update race in read-modify-write vault write tools (create_task, update_task, edit_note append/prepend, insert_into_active_note disk fallback) by using Obsidian's Vault.process atomic RMW API. Reported by user: parallel create_task calls to same daily note caused only last writer's task to persist.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
