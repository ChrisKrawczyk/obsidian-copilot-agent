# WorkflowContext

Work Title: Agent-native vault tools
Work ID: agent-native-vault-tools
Base Branch: main
Target Branch: feature/agent-native-vault-tools
Execution Mode: current-checkout
Repository Identity: github.com/chriskrawczyk/obsidian-copilot-agent@e2ac86c62d1416ce9ee8ae372a479b1a88e78948
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: planning-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: society-of-thought
Final Review Interactive: smart
Final Review Models: latest GPT, latest Gemini, latest Claude Opus
Final Review Specialists: all
Final Review Interaction Mode: debate
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: single-model
Plan Generation Models: latest GPT, latest Gemini, latest Claude Opus
Planning Docs Review: enabled
Planning Review Mode: multi-model
Planning Review Interactive: smart
Planning Review Models: latest GPT, latest Gemini, latest Claude Opus
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: none
Initial Prompt: Ship an upgraded set of vault navigation tools for the Obsidian Copilot agent, as designed in proposals/0010-agent-native-vault-tools.md (currently on branch proposal/0010-agent-native-vault-tools, PR #12). The proposal supersedes proposal 0004 (rejected). Key deliverables sketched in the proposal: (1) upgrade `search_content` to use Obsidian's public `prepareSimpleSearch`/`prepareFuzzySearch` for ranked/fuzzy matching while preserving the existing regex path, (2) add a compound `search_vault` tool that composes metadata-cache filters (tag / path_prefix / modified_since) with text search, (3) add structural tools `resolve_link`, `get_outlinks`, `get_note_structure`, and `related_notes` (link-graph-only), (4) optionally register a `dataview_query` tool guarded by `getAPI(app)` when Dataview is installed. All changes read-only, additive to the existing vault-tool inventory in `src/domain/vaultToolManifest.ts`, and must keep the current v0.9 test suite green.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: proposal 0010 (branch proposal/0010-agent-native-vault-tools, PR #12); Obsidian API research at C:/Users/chkraw/AppData/Local/Temp/1783354058213-copilot-tool-output-2ikdtt.txt (may not survive session)
