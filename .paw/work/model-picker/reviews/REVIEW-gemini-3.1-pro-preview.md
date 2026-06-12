# Spec Review: model-picker

**Verdict**: PASS-with-fixes

**Summary**: 16/19 criteria passing. The spec is well-written and covers the core mechanics of the model picker, persistence, and mid-conversation swaps gracefully. However, it leaks implementation details, lacks explicit bulleted objectives, and misses FR mappings in the Success Criteria. Additionally, the interaction between the existing "Undo journal" feature and mid-conversation model swaps should be clarified.

## Issues Found (3 criteria failing)

### 1. Content Quality -> No code artifacts (Severity: must-fix)
- **Issue**: The specification includes implementation details like API signatures, class names, file paths, and type definitions instead of describing behavior.
- **Affected section(s)**: 
  - Overview (`pickModel()`)
  - FR-001 (`modelId: string \| null`)
  - FR-005, FR-011, FR-016 (`sendMessage`)
  - NFR-004 (`CopilotAgentSession`, `liveRuntimes`, `main.ts`)
  - Assumptions (`client.createSession({ model, ... })`, `src/sdk/AgentSession.ts`, `SafetySettingsStore`)
- **Suggestion**: Replace these code artifacts with conceptual descriptions (e.g., "send message boundary", "session manager", "persisted conversation properties").

### 2. Narrative Quality -> Objectives present (Severity: should-fix)
- **Issue**: The spec lacks a bulleted list of behavioral objectives. The Problem Statement lists user pain points and ends with a single paragraph goal, which does not fulfill the requirement for bulleted goals.
- **Affected section(s)**: Problem Statement / Overview
- **Suggestion**: Convert the single-paragraph Goal into a bulleted list of behavioral objectives focusing on what the system will do from a user perspective.

### 3. Requirement Completeness -> SCs linked (Severity: must-fix)
- **Issue**: The Success Criteria do not reference the relevant Functional Requirement (FR) IDs they validate.
- **Affected section(s)**: Success Criteria table
- **Suggestion**: Add a column or inline references in the Success Criteria table mapping each SC to its corresponding FR IDs.

## Additional Edge Cases / Considerations (Severity: consider)

- **Interaction with Undo Journal**: The v0.3 feature "Undo journal" is mentioned in baseline (SC-006). If a user swaps the model mid-conversation, sends a message, and then hits "Undo", does the `modelId` swap get reverted as part of the turn, or does the conversation remain on the newly selected model? Clarifying this in the Edge Cases or FRs would be valuable before implementation.