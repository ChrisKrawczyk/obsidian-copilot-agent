# WorkflowContext

Work Title: Importable Preset Packs
Work ID: preset-packs
Base Branch: main
Target Branch: feature/preset-packs
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: society-of-thought
Final Review Interactive: smart
Final Review Models: none
Final Review Specialists: all
Final Review Interaction Mode: debate
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
Custom Workflow Instructions: |
  This work spans TWO repositories:

  1. obsidian-copilot-agent (THIS repo, public) — implements the
     "importable preset packs" plugin feature per
     proposals/0007-importable-preset-packs.md. All plugin code, tests,
     docs, and the PAW workflow artifacts live here. The Final PR
     against `main` targets this repo.

  2. obsidian-copilot-presets-internal (sibling repo at
     <companion-private-repo>, PRIVATE) — hosts the
     internal M365 MCP preset packs that the new plugin
     feature is designed to consume. Pack content authored there is
     committed and pushed in that repo independently of the plugin PR
     workflow. The plugin feature must NOT leak internal package /
     organization names, URLs, or other organization-internal metadata
     into the public repo — generic forward-compat terms only (see the
     v0.7.0 scrub for the established pattern).

  Planning should treat the two repos as separate deliverables:
  - Plugin feature phases drive the PRs in obsidian-copilot-agent
  - The starter internal-organization pack is a deliverable in
    obsidian-copilot-presets-internal but ships outside the PAW PR flow

  Round-trip testing must validate end-to-end: pack authored in the
  private repo, imported via the plugin, registered MCP servers spawn
  and resolve credentials correctly.
Initial Prompt: Implement proposals/0007-importable-preset-packs.md (importable preset packs for the plugin) AND author a starter internal M365 preset pack in a new sibling private repo (obsidian-copilot-presets-internal) that exercises the new feature end-to-end.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none

