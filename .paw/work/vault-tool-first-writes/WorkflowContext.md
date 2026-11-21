# WorkflowContext

Work Title: Vault Tool-First Writes
Work ID: vault-tool-first-writes
Base Branch: main
Target Branch: feature/vault-tool-first-writes
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: full
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
Custom Workflow Instructions: none. Skip work shaping. Resolve open questions autonomously with evidence and record assumptions in the Spec. No shell guard (do not reject or add approvals to shell commands targeting the vault). Do NOT cut a release. Add proposals/0013-vault-tool-first-writes.md (Status: In Progress -> Shipped with PR link at end) and index it in proposals/README.md. After PR, run npm run deploy.
Initial Prompt: When the in-Obsidian agent finds a vault tool slow, approval-heavy, or missing, it routes around the vault tools and mutates vault files directly with shell commands (PowerShell/bash/Python: Move-Item, Set-Content, WriteAllText, etc.). That bypasses SafetyPolicy approvals and the UndoJournal, and shell moves don't update wikilinks. Drivers: (a) update_task edits only one task per call; (b) no vault tool to move/rename notes. Goal: make the shell path unnecessary and less enticing, NOT block it. Scope: (1) preamble hard rule "Vault writes" in the default preamble (within MAX_DEFAULT_PREAMBLE_BYTES; consider a custom-mode placeholder), update "Editing tasks" guidance to the batch tool and point move/rename at new tools; (2) update_tasks batch tool — one change applied to many tasks (path, line, expectedRawLine) with ONE approval and ONE atomic multi-file undo entry, validate-all-then-apply; (3) move_note/rename_note via app.fileManager.renameFile (links update), SafetyPolicy-gated, undoable (move back); target-exists, folder creation, non-markdown decided in spec; (4) bulk_edit find/replace across files with per-file preview in approval, one approval, one undo entry; (5) change detection: warn in chat when vault files change outside vault tools during a session, avoiding false positives from user edits and plugin writes; pure logic unit-testable. Register tools in vaultToolManifest.ts, src/tools/*, main.ts wiring, ToolCallBlock undo support; update README/CHANGELOG (Unreleased).
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
