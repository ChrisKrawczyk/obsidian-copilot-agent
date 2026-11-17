# 0009: MCP HTTP — one-shot retry for transient 5xx (502/503/504)

**Status:** Draft
**Filed:** 2026-07-02

## Problem

`McpHttpClient` retries once on **401** responses (v0.7's cache-invalidation-then-retry
for expired credentials). Transient upstream gateway errors —
**502**, **503**, **504** — are surfaced to the model as content on the first
attempt (v0.8 hardening), leaving it up to the model to notice and retry.

Observed after v0.9.0 smoke testing:

- `az logout` → `az login` → v0.9 auto tool-refresh Notice fires correctly →
  next M365 Graph tool call returns **504 Gateway Timeout** on the
  freshly-authed session.
- Second call ~30 s later succeeds. The 504 was a transient upstream Graph
  timeout, not a stale-credential issue.

User experience: "the plugin says my tools refreshed, but now they don't
work" false-negative that resolves on retry.

## Sketch

Add a **single one-shot retry** for a narrow set of transient upstream
status codes, distinct from the existing 401 retry path.

**Statuses:** `502`, `503`, `504`. Explicitly NOT `500` (usually a genuine
server bug that persists across retries).

**Policy:**

- One retry per call, matching the shape of the existing 401 retry.
- Short backoff (~200–500 ms) before the retry.
- Do NOT invalidate the credential cache on 5xx (unlike 401) — the token
  is fine; the upstream is slow.
- Retry-then-fail surfaces as content (existing v0.8 behavior). No loops.

**Non-goals:**

- Not a general-purpose fetch retry library. Scope is `McpHttpClient` only.
- Not idempotency-aware — MCP protocol assumes tool calls are the atomic
  unit; duplicate side effects are the tool's problem.
- No new settings knob. Retry taxonomy lives in code.

## Alternatives considered

1. **Retry 500 too.** Rejected — 500 usually indicates a real server bug
   that persists; a retry delays diagnosis.
2. **Multi-attempt with exponential backoff.** Rejected as scope creep.
   One-shot mirrors the existing 401 pattern and covers the common case.
3. **Ask the model to retry.** Current behavior. Works but costs a turn of
   latency + tokens for a well-known transient class of failures.

## Implementation notes

- Same file as the existing 401 retry (likely `src/mcp/McpHttpClient.ts`).
- Tests: parameterize the 401-retry template over `[502, 503, 504]`.
  Explicit "500 does NOT retry" test. Retry-then-fail surfaces as content.
- No user-facing doc updates needed since there is no settings surface.

## Open questions

- Backoff duration: is 200 ms enough for a Graph 504 to clear, or do we
  want closer to 500 ms? Empirically the 504 observed at v0.9.0 smoke
  cleared in ~30 s wall-clock, but that includes the user's own reaction
  time — a lower bound for "when would a retry have succeeded" is unclear
  without instrumentation.
- Should the retry be gated on a per-server toggle? Currently the 401
  retry is unconditional; matching that default seems fine, but some
  MCP servers may not want retries for auditability reasons.
- Interaction with future proposals: if 0006 (`oauth-pkce`) lands and
  introduces its own auth-refresh flow, the retry classification table
  should be re-audited to make sure 401 and 5xx paths compose cleanly.

## Priority

Low. The 504 case is recoverable (user or model retries). Not blocking
any current feature. Good candidate to bundle with the next auth-adjacent
change.

## Provenance

Surfaced during v0.9.0 smoke testing (PR #10). Original stack:

```
MCP HTTP request failed with status 504.
McpHttpError: MCP HTTP request failed with status 504.
    at eval (plugin:obsidian-copilot-agent:163:2295)
    at async fi.send (plugin:obsidian-copilot-agent:158:5728)
```
