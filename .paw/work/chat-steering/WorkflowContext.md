# WorkflowContext

Work Title: Chat Steering and Queueing
Work ID: chat-steering
Base Branch: main
Target Branch: feature/chat-steering
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
Initial Prompt: Add mid-turn steering and queueing to the chat composer, matching the Copilot CLI and VS Code Copilot Chat patterns. Copilot CLI: Enter while the agent works steers (message joins the running turn, read before the next model request); Ctrl+Q queues it as a new turn after the current one; Up on the first line retracts an unread steering message; Ctrl+C stops and drops the queue. VS Code (1.109): while a request runs, the send action offers Add to Queue / Steer with Message / Stop and Send. The SDK (@github/copilot-sdk 1.0.34) exposes this via session.send({ prompt, mode: "immediate" | "enqueue" }); an immediate message not consumed before the turn ends is promoted to the front of the queue. Today ChatView disables the composer for the whole turn (setBusy) and decideKeydownAction returns noop-prevent while streaming (spec FR-004 "Enter never stops a stream"), and each turn owns a single assistant placeholder.
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: none
