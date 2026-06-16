# MCP Client Planning Synthesis Notes

## Inputs

- `PLAN-gpt-5.4.md`
- `PLAN-gemini-3.1-pro-preview.md`
- `PLAN-claude-opus-4.7.md`

## Differences

- **Phase count:** GPT and Gemini proposed 7 phases. Claude proposed 8 phases by splitting stdio and HTTP transports and moving a dedicated no-MCP/bundle hardening pass before docs.
- **Ordering:** GPT and Claude both put stable persistence first and safety-gate wiring before tool execution. Gemini put Settings UI in Phase 1 and Safety in Phase 4, which was less safe because transports/registry could exist before the final gate contract.
- **Transport granularity:** Claude split stdio and HTTP, which gave strong detail but made the cadence longer than v0.4. GPT grouped them into one headless runtime/discovery phase with explicit tests; this better matches the desired 6–8 shippable cadence.
- **Settings:** Gemini prioritized early Settings UI. GPT delayed Settings until the headless runtime and validation surfaces exist. The synthesis chose GPT’s boundary so UI code consumes tested store/runtime contracts.
- **Resilience:** Claude had the strongest standalone no-MCP smoke and bundle-check emphasis. GPT had the cleanest list_changed/reconnect/cancellation grouping. The synthesis merged both into Phase 6 plus the traceability/baseline matrices.
- **Traceability:** GPT’s FR/NFR/SC matrix best matched the revised 30-FR spec. Claude’s matrix appeared to reflect an older requirement numbering in several rows, so it was not used as the canonical mapping.

## Chosen phase boundaries

1. **Persistence shape + stable MCP identity** was chosen as Phase 1 because all later safety and revocation behavior depends on stable server id and trust epoch.
2. **SafetyPolicy gate + safe approval rendering** was chosen as Phase 2 so no later transport/tool execution path can bypass `decideSafety(...)`.
3. **Runtime substrate + bounded discovery** groups stdio and Streamable HTTP headless work; this keeps protocol/security logic testable before DOM/chat integration.
4. **Settings UI + lifecycle** follows the runtime so add/edit/reconnect/remove actions bind to concrete manager/store APIs.
5. **Tool registry + AgentSession bridge + preamble/results** is the first end-to-end tool surfacing phase and depends on persistence, safety, runtime, and settings.
6. **Resilience hardening** collects cross-cutting active-call behavior: reconnect, crashloop, stale sessions, cancellation, list_changed, and shutdown.
7. **Documentation** remains final, matching v0.4 cadence and ensuring Docs.md/README/CHANGELOG describe the implemented system.

## Key synthesis decisions

- Recommended SDK version is `@modelcontextprotocol/sdk@1.29.0`.
- Final plan uses 7 phases.
- The safety gate is wired before transports can execute.
- Tool surfacing is delayed until Phase 5 to preserve v0.4 behavior in intermediate phases.
- No-MCP baseline preservation is tracked across all phases, not deferred only to the end.
