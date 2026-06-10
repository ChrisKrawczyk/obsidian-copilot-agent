import type { PermissionDecider } from "../domain/PermissionDecision";
import type { PermissionRequest } from "../domain/types";
import { isAuthError as isAuthErrorLocal } from "../auth/isAuthError";
import {
  decideSafety,
  type SafetyConfig,
  type SafetyDecisionResult,
  type SafetyPolicyInput,
  type SafetyState,
} from "../domain/SafetyPolicy";
import { isWriteToolName } from "../tools/WriteTools";

export interface AssistantMessage {
  /** Rendered text from the model. May be empty if the turn produced only tool errors. */
  content: string;
  /** Tool calls that ran or were rejected during this turn. */
  toolCalls: AssistantToolCall[];
}

export interface AssistantToolCall {
  id: string;
  /** SDK request `kind` (`shell`, `mcp`, `custom-tool`, etc.) when known. */
  kind: string;
  name?: string;
  /**
   * Phase 5: source classification for the UI tool-call block.
   *   - `custom`  — registered by us (the read tools)
   *   - `mcp`     — provided by an MCP server (Phase 8)
   *   - `builtin` — bundled with the CLI runtime (shell, web_fetch, …)
   */
  source?: "custom" | "mcp" | "builtin";
  outcome: "denied" | "approved" | "completed" | "errored" | "pending_approval";
  detail?: string;
  /** Truncated JSON of the tool arguments for display. */
  argsPreview?: string;
  /** Tool result content (when completed). */
  resultContent?: string;
  /**
   * Phase 6: when `outcome === "pending_approval"`, populated with the
   * data needed by the UI approval prompt. Cleared once the user makes
   * a choice. Always undefined for non-pending entries.
   */
  approval?: {
    /** Human-readable summary line (e.g. "Edit inbox/today.md"). */
    summary: string;
    /** Long-form prompt body (e.g. full shell command, write diff). */
    detail?: string;
    /** Whether the prompt should offer an "Approve for Session" button. */
    canOfferSession: boolean;
  };
}

export interface AgentSessionOptions {
  /** Resolved absolute path to the Copilot CLI single-executable binary. */
  cliPath: string;
  /**
   * GitHub token (gho_/ghp_). Phase 3: optional — when omitted, init() will
   * reject until setToken() is called by the AuthController. This lets us
   * construct the agent at plugin load time and wire the token in once
   * the user has authenticated.
   */
  gitHubToken?: string | null;
  /** COPILOT_HOME for the runtime (we point it at the plugin dir). */
  baseDirectory: string;
  /** Universal-approval-gate decider. Phase 2 = denyAll. Used as a fallback when `safety` is not provided. */
  decider: PermissionDecider;
  /**
   * Phase 6: when present, replaces `decider` as the policy source.
   * Each `handlePermission` call routes through `decideSafety(input,
   * config, state)`; `require-approval` outcomes block on
   * `onApprovalNeeded` (which the UI fulfils via `resolveApproval`).
   * Leave undefined to retain Phase 2's legacy `decider` path.
   */
  safety?: {
    /** Live policy configuration; read on every decision so settings updates apply immediately. */
    config: () => SafetyConfig;
    /** In-memory session-grants store. */
    state: SafetyState;
    /**
     * Optional: convert an SDK permission request into a vault-relative
     * path (when the request targets a vault write tool). The session
     * uses this to feed `SafetyPolicyInput.vaultRelativePath` to the
     * decision function. Returning undefined means "not a vault path".
     */
    extractVaultPath?: (request: SdkPermissionRequest) => string | undefined;
  };
  /** Optional: skip listModels and force a specific model id. */
  preferredModel?: string;
  /** Optional: forwarded to the SDK CopilotClient as logLevel. */
  logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
  /**
   * Called when init() or sendMessage() fails with what looks like an
   * auth error. Lets AuthController flip to its `error` state so the UI
   * prompts the user to reconnect, instead of silently retrying.
   */
  onAuthError?: (err: unknown) => void;
  /**
   * Phase 5: custom tools to register with each session (read_file,
   * view, search_content). Each tool's handler runs in-process inside
   * the renderer; see `src/tools/ReadTools.ts`. Empty / undefined =
   * no custom tools (legacy Phase 1–4 behaviour).
   */
  tools?: SdkTool[];
  /**
   * Phase 2 (Chat UX + Vault Tools): callback invoked on the FIRST
   * `sendMessage`/`sendMessageStreaming` of each SDK session (i.e. on
   * init() and on each `resetConversation()`). Its return value is
   * prepended to the user's text with a documented marker so the model
   * receives vault context before responding. Lazy so settings changes
   * apply on the next reset without restarting the runtime. Return
   * null/empty to skip prepending.
   */
  preamble?: () => string | null;
}

/**
 * Minimal structural shape of the SDK `Tool` returned by
 * `defineTool()`. We don't import the SDK type here so the file
 * stays unit-testable without the runtime SDK install.
 */
export interface SdkTool {
  name: string;
  description?: string;
  parameters?: unknown;
  handler?: (args: unknown, invocation: unknown) => Promise<unknown> | unknown;
  overridesBuiltInTool?: boolean;
  skipPermission?: boolean;
}

export interface AssistantToolCallExtras {
  /** Truncated string representation of the tool arguments. */
  argsPreview?: string;
  /** When the tool ran successfully, the result text the model saw. */
  resultContent?: string;
}

/**
 * Normalised stream event surface consumed by the chat view. Insulates
 * the UI from the raw SDK event shape so Phase 5 can extend this (e.g.
 * with `tool_call`) without touching the renderer plumbing.
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool_call_start";
      toolCall: AssistantToolCall;
    }
  | {
      type: "tool_call_complete";
      id: string;
      outcome: "completed" | "errored" | "denied";
      content?: string;
      errorMessage?: string;
    }
  | {
      // Phase 6: emitted by handlePermission when SafetyPolicy returns
      // `require-approval`. Consumed by ChatView to upsert a pending
      // tool-call block (containing the ApprovalPrompt UI). When the
      // user clicks Approve/Reject, ChatView calls
      // `agent.resolveApproval(toolCallId, choice)`, which resolves a
      // deferred in pendingApprovals.
      type: "approval_prompt";
      toolCall: AssistantToolCall;
    }
  | {
      // Phase 6: emitted from `resolveApproval` so the UI flips the
      // tool-call block from pending → approved (or denied) before the
      // SDK's own tool.execution_* events arrive.
      type: "approval_resolved";
      id: string;
      choice: ApprovalChoice;
    }
  | { type: "complete"; content: string; toolCalls: AssistantToolCall[] };

/** User's response to a pending approval prompt. */
export type ApprovalChoice =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; reason?: string };

/**
 * Public adapter surface. The rest of the codebase consumes this — the
 * concrete CopilotAgentSession encapsulates all SDK interactions.
 */
export interface AgentSession {
  /** Idempotent. Resolves once the SDK is up and a session is created. */
  init(): Promise<void>;
  /** Send a user message and await a single assistant turn. Non-streaming. */
  sendMessage(text: string): Promise<AssistantMessage>;
  /**
   * Streaming variant. Emits `delta` events as the SDK forwards
   * `assistant.message_delta` chunks, then a single terminal `complete`
   * event carrying the consolidated text and tool-call summary.
   *
   * Cancellation: call `cancelCurrent()` to abort. The iterator stops
   * cleanly; whatever partial text was already yielded is left to the
   * caller to render (Phase 4 freezes it as `interrupted`).
   */
  sendMessageStreaming(text: string): AsyncIterable<StreamEvent>;
  /**
   * Abort an in-flight `sendMessage`/`sendMessageStreaming`. Safe to
   * call when nothing is in flight (no-op). The SDK session itself
   * remains usable for the next turn.
   */
  cancelCurrent(): Promise<void>;
  /** Reset the SDK session so model context is forgotten. */
  resetConversation(): Promise<void>;
  /**
   * Swap the GitHub token. Stops the running SDK runtime so the next
   * init() picks up the new token. Pass `null` to disconnect (init()
   * will reject until a non-null token is set).
   *
   * IMPORTANT: this is non-terminal — the AgentSession can be reused
   * after setToken(). Use `dispose()` only at plugin unload.
   */
  setToken(token: string | null): Promise<void>;
  /**
   * Force a fresh init() cycle and return the resolved model id. Used
   * by AuthController to validate a new or persisted token.
   */
  reconnect(): Promise<string | undefined>;
  /** Tear down the SDK session and stop the runtime. Idempotent.
   *  TERMINAL — after dispose() the AgentSession cannot be reused. */
  dispose(): Promise<void>;
  /** Currently selected model id, or undefined if init hasn't run. */
  getModel(): string | undefined;
  /**
   * Phase 6: resolve a pending approval prompt with the user's choice.
   * Called by the chat view when the user clicks an approval button.
   * No-op if no approval is pending for this tool-call id (e.g. the
   * prompt was already auto-rejected during cleanup).
   */
  resolveApproval(toolCallId: string, choice: ApprovalChoice): void;
}

const SDK_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

export class CopilotAgentSession implements AgentSession {
  private initPromise: Promise<void> | null = null;
  private client: SdkClient | null = null;
  private session: SdkSession | null = null;
  private selectedModel: string | undefined;
  /** Set once `dispose()` runs. Terminal — blocks all future init(). */
  private disposed = false;
  /**
   * Monotonic counter incremented whenever the runtime is torn down
   * (`stopRuntime`, `dispose`). `doInit` captures this value at the
   * start of its run and bails (cleaning up any client it built) if it
   * sees the counter has advanced at any `await` boundary. This closes
   * a Windows-cold-start race where `setToken()` rotates the token,
   * `stopRuntime` times out waiting for the slow in-flight init, nulls
   * `this.client`/`this.session`, and then the in-flight init resumes
   * and re-assigns those fields with a client built from the OLD token
   * — leaking the subprocess and producing a stale-token session.
   */
  private initEpoch = 0;
  /**
   * Current OAuth token. Mutable so AuthController can rotate it via
   * `setToken()` without rebuilding the AgentSession instance. `null`
   * means "not connected" — init() will reject.
   */
  private currentToken: string | null;
  private toolCallsThisTurn: AssistantToolCall[] = [];

  /**
   * Upsert by id into `toolCallsThisTurn`. Used by handlePermission to
   * avoid creating a duplicate entry when `tool.execution_start` already
   * fired for the same toolCallId before permissionRequested. Without
   * this, end-of-stream replay (`yield {type: "complete", toolCalls}`)
   * would surface the lingering pending_approval entry and regress the
   * UI from completed back to pending.
   */
  private upsertTurnToolCall(call: AssistantToolCall): void {
    const idx = this.toolCallsThisTurn.findIndex((c) => c.id === call.id);
    if (idx < 0) {
      this.toolCallsThisTurn.push(call);
      return;
    }
    this.toolCallsThisTurn[idx] = { ...this.toolCallsThisTurn[idx], ...call };
  }

  private readonly sdkLoader: () => Promise<SdkModule>;
  /**
   * Set during sendMessageStreaming. When non-null, handlePermission +
   * tool.execution_* handlers mirror their events to the live stream
   * consumer so the chat view can render tool-call blocks in real time.
   * Cleared on stream teardown so out-of-band events (a stray
   * post-stream tool completion) don't try to push into a dead queue.
   */
  private currentStreamPush:
    | ((ev: StreamEvent) => void)
    | null = null;
  /**
   * Set of tool names we registered as custom tools, used to classify
   * tool sources (`custom` vs `builtin`/`mcp`) in the chat UI.
   */
  private readonly customToolNames: Set<string>;
  /**
   * Defensive copy of `opts.tools` so external mutation can't surprise
   * us between the init() and resetConversation() createSession calls.
   */
  private readonly toolsList: SdkTool[] | undefined;
  /**
   * Phase 6: in-flight approval prompts keyed by tool-call id. Resolved
   * by `resolveApproval`; rejected en masse by `cancelAllPendingApprovals`
   * on cancel/reset/dispose/setToken so a dangling deferred never
   * leaves the SDK awaiting a response. The value type is a deferred
   * holding the user's choice (never rejects the underlying promise —
   * cancellation resolves with `{ kind: "reject", reason: ... }` so
   * the SDK contract returns a clean PermissionRequestResult).
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (choice: ApprovalChoice) => void;
      promise: Promise<ApprovalChoice>;
    }
  >();

  /**
   * Memo of approval choices already resolved for a given toolCallId in
   * this session. The SDK can re-emit `permissionRequested` for an already-
   * approved/rejected toolCall (e.g., on agent-loop replay or follow-up
   * iterations). When that happens we must NOT prompt the user again —
   * we'd flip the UI back to pending_approval after the call has already
   * completed, and the new Deferred would never resolve. Instead, we
   * short-circuit with the prior choice.
   */
  private readonly resolvedApprovals = new Map<string, ApprovalChoice>();

  /**
   * Phase 2 (Chat UX + Vault Tools): true until the first
   * `sendMessage`/`sendMessageStreaming` of the current SDK session has
   * been issued. Reset to true on every `createSession` (init + reset).
   * When true, `wrapWithPreamble` prepends the vault-aware preamble to
   * the outgoing text. Flipped to false after the prepended text has
   * been handed to `session.sendAndWait`.
   */
  private firstSendOfSession = true;
  /**
   * Diagnostics hook: records the text actually sent to the SDK on the
   * most recent first-send and on the most recent subsequent send. Used
   * by unit tests to verify (a) preamble was prepended on first send,
   * (b) second send is untouched. Not part of the public AgentSession
   * surface — read via `preambleProbe()`.
   */
  private lastFirstSendText: string | null = null;
  private lastFollowupSendText: string | null = null;

  constructor(
    private readonly opts: AgentSessionOptions,
    sdkLoader?: () => Promise<SdkModule>,
  ) {
    this.sdkLoader = sdkLoader ?? defaultSdkLoader;
    this.currentToken = opts.gitHubToken ?? null;
    this.toolsList = opts.tools ? [...opts.tools] : undefined;
    this.customToolNames = new Set(
      (this.toolsList ?? []).map((t) => t.name).filter(Boolean) as string[],
    );
  }

  getModel(): string | undefined {
    return this.selectedModel;
  }

  init(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("AgentSession disposed"));
    }
    if (!this.currentToken) {
      return Promise.reject(
        new Error("AgentSession has no GitHub token. Connect first."),
      );
    }
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so a future caller can retry with a fresh attempt.
        this.initPromise = null;
        // Surface auth failures to AuthController so it can flip its
        // state to `error` instead of leaving the UI on "Connecting…".
        if (this.opts.onAuthError && isAuthErrorLocal(err)) {
          try {
            this.opts.onAuthError(err);
          } catch (e) {
            console.warn("[AgentSession] onAuthError handler threw", e);
          }
        }
        throw err;
      });
    }
    return this.initPromise;
  }

  async sendMessage(text: string): Promise<AssistantMessage> {
    try {
      await this.init();
    } catch (err) {
      // init() already invoked onAuthError if applicable; rethrow so the
      // chat view can show the failure to the user.
      throw err;
    }
    if (!this.session) {
      throw new Error("AgentSession.session missing after init");
    }
    this.toolCallsThisTurn = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        this.session?.abort?.();
      } catch (e) {
        console.warn("[AgentSession] abort on timeout failed", e);
      }
    }, SDK_TIMEOUT_MS);
    try {
      const outgoing = this.wrapWithPreamble(text);
      const resp = await this.session.sendAndWait(outgoing);
      if (timedOut) {
        throw new Error(
          `Model did not respond within ${SDK_TIMEOUT_MS / 1000}s`,
        );
      }
      return {
        content: extractText(resp) ?? "",
        toolCalls: this.toolCallsThisTurn,
      };
    } catch (err) {
      if (this.opts.onAuthError && isAuthErrorLocal(err)) {
        try {
          this.opts.onAuthError(err);
        } catch (e) {
          console.warn("[AgentSession] onAuthError handler threw", e);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streaming variant of {@link sendMessage}. Implementation notes:
   *
   * - Subscribes to `assistant.message_delta` *before* sending so we never
   *   race the SDK and drop the first chunk.
   * - `session.sendAndWait()` resolves once the SDK emits `session.idle`,
   *   at which point we yield a terminal `complete` event containing the
   *   final consolidated content (which may differ slightly from the
   *   concatenated deltas — e.g. when the model produces tool calls
   *   between text segments).
   * - On `cancelCurrent()` the underlying promise typically rejects; we
   *   translate that into a terminal `complete` with whatever text the
   *   chat layer already accumulated and let the chat layer freeze the
   *   message as `interrupted`.
   * - On any non-cancel error we re-throw so the chat layer can render
   *   the failure.
   */
  async *sendMessageStreaming(text: string): AsyncIterable<StreamEvent> {
    try {
      await this.init();
    } catch (err) {
      throw err;
    }
    if (!this.session) {
      throw new Error("AgentSession.session missing after init");
    }
    const session = this.session;
    this.toolCallsThisTurn = [];

    const queue: StreamEvent[] = [];
    let resolveWait: (() => void) | null = null;
    /**
     * Set to false once we yield a terminal `complete` or throw.
     * Subsequent delta callbacks are dropped so a stray event from the
     * SDK after settlement can't corrupt state.
     */
    let acceptingDeltas = true;
    const push = (ev: StreamEvent): void => {
      if (!acceptingDeltas && ev.type === "delta") return;
      queue.push(ev);
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };
    // Expose to handlePermission + tool-event handlers so denied
    // built-ins and completed custom-tool calls reach the chat UI
    // live. Cleared in finally so post-stream events can't push into
    // a dead queue.
    this.currentStreamPush = push;

    // Subscribe *before* sending so the first delta isn't lost.
    let unsubDelta: (() => void) | undefined;
    let unsubToolStart: (() => void) | undefined;
    let unsubToolComplete: (() => void) | undefined;
    if (typeof session.on === "function") {
      try {
        unsubDelta = session.on("assistant.message_delta", (event) => {
          const delta = event?.data?.deltaContent;
          if (typeof delta === "string" && delta.length > 0) {
            push({ type: "delta", text: delta });
          }
        });
      } catch (e) {
        console.warn("[AgentSession] session.on subscribe failed", e);
      }
      try {
        unsubToolStart = session.on("tool.execution_start", (event) => {
          const d = event?.data;
          if (!d || typeof d.toolCallId !== "string") return;
          const source = classifyToolSource(
            d.mcpServerName ? "mcp" : undefined,
            d.toolName,
            this.customToolNames,
          );
          // Build / refresh the assistant tool-call record. If
          // handlePermission already pushed an entry (approved
          // permission flow), update it; otherwise (skipPermission
          // tools) create a fresh one.
          let existing = this.toolCallsThisTurn.find(
            (c) => c.id === d.toolCallId,
          );
          const argsPreview = stringifyArgsForPreview(d.arguments);
          if (existing) {
            existing.source = source;
            existing.argsPreview = argsPreview;
            if (!existing.name) existing.name = d.toolName;
          } else {
            existing = {
              id: d.toolCallId,
              kind: source === "mcp" ? "mcp" : "tool",
              name: d.toolName,
              source,
              outcome: "approved",
              argsPreview,
            };
            this.toolCallsThisTurn.push(existing);
          }
          push({ type: "tool_call_start", toolCall: { ...existing } });
        });
      } catch (e) {
        console.warn("[AgentSession] session.on tool.start subscribe failed", e);
      }
      try {
        unsubToolComplete = session.on("tool.execution_complete", (event) => {
          const d = event?.data;
          if (!d || typeof d.toolCallId !== "string") return;
          const existing = this.toolCallsThisTurn.find(
            (c) => c.id === d.toolCallId,
          );
          const outcome: "completed" | "errored" = d.success
            ? "completed"
            : "errored";
          const resultContent =
            d.result?.detailedContent ?? d.result?.content ?? undefined;
          const errorMessage = d.error?.message;
          if (existing) {
            existing.outcome = outcome;
            // Clear approval metadata once the call has executed; the
            // UI gates the prompt on `outcome === "pending_approval"`,
            // but a stale approval object on a completed entry is
            // confusing if anything else inspects it.
            existing.approval = undefined;
            if (resultContent !== undefined)
              existing.resultContent = resultContent;
            if (errorMessage !== undefined) existing.detail = errorMessage;
          }
          push({
            type: "tool_call_complete",
            id: d.toolCallId,
            outcome,
            content: resultContent,
            errorMessage,
          });
        });
      } catch (e) {
        console.warn(
          "[AgentSession] session.on tool.complete subscribe failed",
          e,
        );
      }
    }
    const cleanupSubscription = (): void => {
      for (const u of [unsubDelta, unsubToolStart, unsubToolComplete]) {
        if (!u) continue;
        try {
          u();
        } catch (e) {
          console.warn("[AgentSession] unsubscribe failed", e);
        }
      }
      unsubDelta = undefined;
      unsubToolStart = undefined;
      unsubToolComplete = undefined;
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.cancelCurrent().catch((e) =>
        console.warn("[AgentSession] abort on timeout failed", e),
      );
    }, SDK_TIMEOUT_MS);

    let done = false;
    let settled = false; // sendAndWait has resolved or rejected
    let finalContent = "";
    let failure: unknown = null;

    const wakeup = (): void => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    // Kick off the turn but DON'T await — we need to interleave with
    // the queue draining loop below.
    const outgoing = this.wrapWithPreamble(text);
    session
      .sendAndWait(outgoing)
      .then(
        (resp) => {
          settled = true;
          finalContent = extractText(resp) ?? "";
          done = true;
          wakeup();
        },
        (err) => {
          settled = true;
          // Check timeout BEFORE abort detection: a timeout-triggered
          // abort error must surface as a timeout failure, not be
          // silently swallowed as a user cancellation.
          if (timedOut) {
            failure = new Error(
              `Model did not respond within ${SDK_TIMEOUT_MS / 1000}s`,
            );
          } else if (isAbortError(err)) {
            // User-initiated cancel (or any other abort path) — end
            // the stream cleanly, no failure.
          } else {
            failure = err;
          }
          done = true;
          wakeup();
        },
      );

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
      // Drain any deltas that arrived after `done` flipped but before
      // we re-entered the loop.
      while (queue.length > 0) {
        yield queue.shift()!;
      }

      // Unsubscribe BEFORE yielding the terminal `complete`. This
      // guarantees no late delta can sneak into state after the
      // consumer has accepted the terminal event.
      acceptingDeltas = false;
      cleanupSubscription();

      if (failure) {
        if (this.opts.onAuthError && isAuthErrorLocal(failure)) {
          try {
            this.opts.onAuthError(failure);
          } catch (e) {
            console.warn("[AgentSession] onAuthError handler threw", e);
          }
        }
        throw failure;
      }

      yield {
        type: "complete",
        content: finalContent,
        toolCalls: this.toolCallsThisTurn,
      };
    } finally {
      clearTimeout(timer);
      acceptingDeltas = false;
      cleanupSubscription();
      this.currentStreamPush = null;
      this.cancelAllPendingApprovals(
        "Stream ended before user approved this tool call.",
      );
      // If the consumer closed the iterator early (break, throw, view
      // teardown) the SDK turn may still be in flight. Abort it on the
      // captured `session` so it doesn't keep running in the background
      // and tie up the SDK channel for the next turn. We deliberately
      // use the captured `session` rather than `this.cancelCurrent()`
      // so a reset/reconnect that swapped `this.session` can't make us
      // abort a newer, unrelated turn.
      if (!settled && typeof session.abort === "function") {
        try {
          await Promise.resolve(session.abort());
        } catch (e) {
          console.warn("[AgentSession] early-close abort failed", e);
        }
      }
    }
  }

  async cancelCurrent(): Promise<void> {
    this.cancelAllPendingApprovals("User cancelled the turn.");
    const session = this.session;
    if (!session || typeof session.abort !== "function") return;
    try {
      await Promise.resolve(session.abort());
    } catch (e) {
      console.warn("[AgentSession] session.abort failed", e);
    }
  }

  /**
   * Phase 2: prepend the vault-aware preamble to the FIRST send of the
   * current SDK session. Subsequent sends pass through unchanged. If no
   * preamble callback is configured or it returns null/empty, the text
   * is returned untouched.
   *
   * The marker line distinguishes the preamble block from the user's
   * actual prompt so future log analysis / tests can detect it.
   */
  private wrapWithPreamble(text: string): string {
    if (!this.firstSendOfSession) {
      this.lastFollowupSendText = text;
      return text;
    }
    this.firstSendOfSession = false;
    const preambleFn = this.opts.preamble;
    if (!preambleFn) {
      this.lastFirstSendText = text;
      return text;
    }
    let preamble: string | null;
    try {
      preamble = preambleFn();
    } catch (e) {
      console.warn("[AgentSession] preamble callback threw", e);
      this.lastFirstSendText = text;
      return text;
    }
    if (!preamble) {
      this.lastFirstSendText = text;
      return text;
    }
    const combined =
      preamble + "\n\n---\n\n## User request\n\n" + text;
    this.lastFirstSendText = combined;
    return combined;
  }

  /**
   * Test probe — returns the text most recently handed to
   * `session.sendAndWait` for the first send and the most recent
   * follow-up send. Lets unit tests assert preamble injection without
   * reaching into the SDK fake.
   */
  preambleProbe(): {
    firstSend: string | null;
    followupSend: string | null;
    firstSendArmed: boolean;
  } {
    return {
      firstSend: this.lastFirstSendText,
      followupSend: this.lastFollowupSendText,
      firstSendArmed: this.firstSendOfSession,
    };
  }

  async resetConversation(): Promise<void> {
    this.cancelAllPendingApprovals("Conversation was reset.");
    if (!this.client) {
      this.initPromise = null;
      this.session = null;
      return;
    }
    // Keep the running client; just swap the SDK session so model
    // context resets without paying the runtime-startup cost again.
    const oldSession = this.session;
    this.session = null;
    if (oldSession) {
      await safeCall(() => oldSession.disconnect?.());
    }
    if (!this.selectedModel) {
      this.selectedModel = await this.pickModel(this.client, this.opts.preferredModel);
    }
    const fresh = await this.client.createSession({
      model: this.selectedModel,
      availableTools: ["builtin:*"],
      streaming: true,
      tools: this.toolsList,
      onPermissionRequest: (request: SdkPermissionRequest) =>
        this.handlePermission(request),
    });
    this.session = fresh;
    this.firstSendOfSession = true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllPendingApprovals("Agent disposed.");
    await this.stopRuntime();
  }

  /**
   * Non-terminal shutdown: stop the SDK runtime and drop the session,
   * but keep the AgentSession reusable. Used by `setToken()` so the next
   * `init()` builds a fresh CopilotClient with the new token.
   *
   * Closes the dispose-during-init race the same way `dispose()` did.
   */
  private async stopRuntime(): Promise<void> {
    // Bump the epoch so any in-flight doInit() can detect that its
    // runtime is no longer wanted and bail out cleanly. See the
    // `initEpoch` field docs.
    this.initEpoch++;
    // If init is still in flight, wait briefly so it can either finish
    // (and we then tear it down) or fail (and stay null). This closes
    // the race where Obsidian unloads — or the token rotates — mid-init
    // and leaves a zombie copilot.exe behind.
    if (this.initPromise) {
      await raceWithTimeout(
        this.initPromise.catch(() => {
          /* swallow — we just want to wait for resolution */
        }),
        STOP_TIMEOUT_MS,
      ).catch(() => {
        /* timed out — fall through and tear down whatever exists */
      });
    }
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.initPromise = null;
    this.selectedModel = undefined;

    if (session) {
      await raceWithTimeout(
        safeCall(() => session.disconnect?.()),
        STOP_TIMEOUT_MS,
      ).catch((e) =>
        console.warn("[AgentSession] session.disconnect timed out", e),
      );
    }
    if (client) {
      try {
        await raceWithTimeout(
          safeCall(() => client.stop?.()),
          STOP_TIMEOUT_MS,
        );
      } catch (e) {
        console.warn("[AgentSession] client.stop timed out, force stopping", e);
        try {
          await client.forceStop?.();
        } catch (e2) {
          console.warn("[AgentSession] client.forceStop failed", e2);
        }
      }
    }
  }

  async setToken(token: string | null): Promise<void> {
    if (this.disposed) {
      throw new Error("AgentSession disposed");
    }
    this.cancelAllPendingApprovals("Authentication changed.");
    // Always tear the runtime down first so the next init() picks up
    // the new token. If the token is unchanged we still rebuild — this
    // keeps the lifecycle simple and matches "reconnect" semantics.
    await this.stopRuntime();
    this.currentToken = token;
  }

  async reconnect(): Promise<string | undefined> {
    if (this.disposed) {
      throw new Error("AgentSession disposed");
    }
    // Force a fresh attempt — even if a previous init succeeded, the
    // caller (AuthController) wants to validate the current token.
    await this.stopRuntime();
    await this.init();
    return this.selectedModel;
  }

  // ---- internals ----

  private async doInit(): Promise<void> {
    const epoch = this.initEpoch;
    const sdk = await this.sdkLoader();
    if (this.disposed) throw new Error("AgentSession disposed during init");
    if (this.initEpoch !== epoch) {
      throw new Error("AgentSession runtime torn down during init");
    }
    const CopilotClient = sdk.CopilotClient;
    if (!CopilotClient) {
      throw new Error("@github/copilot-sdk does not export CopilotClient");
    }

    const client = new CopilotClient({
      gitHubToken: this.currentToken ?? "",
      useLoggedInUser: false,
      mode: "empty",
      baseDirectory: this.opts.baseDirectory,
      connection: { kind: "stdio", path: this.opts.cliPath },
      logLevel: this.opts.logLevel ?? "info",
    });

    // From this point on we own a live client. On any post-await disposal
    // OR epoch advance (token rotation / stopRuntime fired while we were
    // mid-init) we MUST tear it down ourselves — stopRuntime can't see
    // a client we haven't assigned to `this.client` yet.
    const bailIfStale = async (): Promise<void> => {
      if (!this.disposed && this.initEpoch === epoch) return;
      await safeCall(() => client.stop?.());
      throw new Error(
        this.disposed
          ? "AgentSession disposed during init"
          : "AgentSession runtime torn down during init",
      );
    };

    try {
      if (typeof client.start === "function") {
        await client.start();
        await bailIfStale();
      }
      if (typeof client.ping === "function") {
        await client.ping();
        await bailIfStale();
      }

      this.client = client;

      const model = await this.pickModel(client, this.opts.preferredModel);
      await bailIfStale();
      this.selectedModel = model;

      const session = await client.createSession({
        model,
        availableTools: ["builtin:*"],
        streaming: true,
        tools: this.toolsList,
        onPermissionRequest: (request: SdkPermissionRequest) =>
          this.handlePermission(request),
      });
      if (this.disposed || this.initEpoch !== epoch) {
        await safeCall(() => session.disconnect?.());
        await safeCall(() => client.stop?.());
        // Also undo the `this.client = client` assignment above so
        // stopRuntime doesn't double-tear-down a client we already
        // stopped here. Guard the null in case a newer init() raced
        // ahead and assigned its own client.
        if (this.client === client) this.client = null;
        throw new Error(
          this.disposed
            ? "AgentSession disposed during init"
            : "AgentSession runtime torn down during init",
        );
      }
      this.session = session;
      this.firstSendOfSession = true;
    } catch (err) {
      // On any failure after the client was constructed, make sure we
      // don't leak the runtime process.
      if (this.client !== client) {
        await safeCall(() => client.stop?.());
      }
      throw err;
    }
  }

  private async pickModel(
    client: SdkClient,
    preferred: string | undefined,
  ): Promise<string> {
    if (preferred) return preferred;
    if (typeof client.listModels !== "function") {
      return "gpt-4.1";
    }
    let models: SdkModelInfo[];
    try {
      models = (await client.listModels()) as SdkModelInfo[];
    } catch (e) {
      throw new Error(
        `[AgentSession] client.listModels failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const enabled = models.filter(
      (m) =>
        !m.policy ||
        m.policy.state === "enabled" ||
        m.policy.state === undefined,
    );
    const pool = enabled.length > 0 ? enabled : models;
    if (pool.length === 0) {
      throw new Error(
        "[AgentSession] No Copilot models available for this account.",
      );
    }
    const chosen =
      pool.find((m) => m.id === "gpt-4.1") ??
      pool.find((m) => m.id === "gpt-4o") ??
      pool.find((m) => (m.id ?? "").startsWith("gpt-")) ??
      pool[0];
    return chosen.id ?? pool[0].id ?? "gpt-4.1";
  }

  private async handlePermission(
    request: SdkPermissionRequest,
  ): Promise<SdkPermissionResult> {
    const normalised: PermissionRequest = {
      kind: request.kind ?? "(unknown)",
      toolName: request.toolName,
      raw: request,
    };
    const toolCallId =
      request.toolCallId ?? request.id ?? `tc${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = classifyToolSource(
      request.kind,
      request.toolName,
      this.customToolNames,
    );
    const argsPreview = previewArgs(request);

    // Phase 6 path: SafetyPolicy decides.
    if (this.opts.safety) {
      return this.handlePermissionViaSafetyPolicy(
        request,
        normalised,
        toolCallId,
        source,
        argsPreview,
      );
    }

    // Legacy Phase-2 fallback path (used by tests that don't wire SafetyPolicy).
    const decision = await this.opts.decider(normalised);
    if (decision.kind === "reject") {
      const call: AssistantToolCall = {
        id: toolCallId,
        kind: normalised.kind,
        name: normalised.toolName,
        source,
        outcome: "denied",
        detail: decision.feedback,
        argsPreview,
      };
      this.toolCallsThisTurn.push(call);
      this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
      this.currentStreamPush?.({
        type: "tool_call_complete",
        id: toolCallId,
        outcome: "denied",
        errorMessage: decision.feedback,
      });
      return { kind: "reject", feedback: decision.feedback ?? "Denied." };
    }
    const call: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "approved",
      argsPreview,
    };
    this.toolCallsThisTurn.push(call);
    return { kind: decision.kind };
  }

  /**
   * Phase 6 permission flow. Per design critique:
   *   - Always return `approve-once` to the SDK (never `approve-for-session`)
   *     so subsequent calls re-enter this function and re-consult our
   *     policy; "approve for session" is implemented via our own
   *     `SafetyState` grants.
   *   - On `require-approval`, push an `approval_prompt` stream event,
   *     await user click via `pendingApprovals` deferred, then map the
   *     choice to an SDK result.
   *   - On cleanup, `cancelAllPendingApprovals` resolves every deferred
   *     with `{ kind: "reject" }` so the SDK never hangs.
   */
  private async handlePermissionViaSafetyPolicy(
    request: SdkPermissionRequest,
    normalised: PermissionRequest,
    toolCallId: string,
    source: "custom" | "mcp" | "builtin",
    argsPreview: string | undefined,
  ): Promise<SdkPermissionResult> {
    // Short-circuit if this toolCallId was already resolved earlier in
    // this session. The SDK can re-emit permissionRequested for an
    // already-handled call; re-prompting would regress the UI from
    // completed back to pending_approval and the new prompt would never
    // be resolved.
    const prior = this.resolvedApprovals.get(toolCallId);
    if (prior) {
      console.log(
        "[copilot-agent] permission re-ask short-circuited",
        "id:",
        toolCallId,
        "priorChoice:",
        prior.kind,
      );
      if (prior.kind === "reject") {
        return { kind: "reject", feedback: prior.reason ?? "Rejected." };
      }
      return { kind: "approve-once" };
    }

    const safety = this.opts.safety!;
    const config = safety.config();
    const input = this.buildSafetyInput(request, safety);
    const decision = decideSafety(input, config, safety.state);

    if (decision.decision === "rejected") {
      this.resolvedApprovals.set(toolCallId, {
        kind: "reject",
        reason: decision.reason,
      });
      return this.recordRejection(
        toolCallId,
        normalised,
        source,
        argsPreview,
        decision,
      );
    }

    if (decision.decision === "auto-apply") {
      // Push an approved entry so the chat shows the tool call ran
      // (without prompting). The SDK will fire tool.execution_* events
      // next; the stream handler will upsert by id.
      const call: AssistantToolCall = {
        id: toolCallId,
        kind: normalised.kind,
        name: normalised.toolName,
        source,
        outcome: "approved",
        detail: decision.reason,
        argsPreview,
      };
      this.upsertTurnToolCall(call);
      this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
      this.resolvedApprovals.set(toolCallId, { kind: "approve-once" });
      return { kind: "approve-once" };
    }

    // require-approval: surface a prompt in the chat and await user click.
    const summary = buildApprovalSummary(request, input);
    const detail = buildApprovalDetail(request);
    const canOfferSession = request.canOfferSessionApproval !== false;
    const pendingCall: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "pending_approval",
      argsPreview,
      approval: { summary, detail, canOfferSession },
    };
    this.upsertTurnToolCall(pendingCall);

    // If no stream is active (e.g. sendMessage non-streaming path) we
    // have no UI to surface the prompt — fail closed.
    if (!this.currentStreamPush) {
      return { kind: "reject", feedback: "No UI available to confirm tool call." };
    }
    this.currentStreamPush({ type: "approval_prompt", toolCall: pendingCall });

    const deferred = makeDeferred<ApprovalChoice>();
    this.pendingApprovals.set(toolCallId, deferred);
    let choice: ApprovalChoice;
    try {
      choice = await deferred.promise;
    } finally {
      this.pendingApprovals.delete(toolCallId);
    }
    this.resolvedApprovals.set(toolCallId, choice);

    // Always emit `approval_resolved` so the UI can transition the
    // pending block to its post-decision state.
    this.currentStreamPush?.({
      type: "approval_resolved",
      id: toolCallId,
      choice,
    });

    if (choice.kind === "reject") {
      const reason = choice.reason ?? "Rejected by user.";
      return this.recordRejection(
        toolCallId,
        normalised,
        source,
        argsPreview,
        { decision: "rejected", reason },
      );
    }

    if (choice.kind === "approve-for-session") {
      // Apply the grant in our local SafetyState. We narrow the grant
      // to the same scope SafetyPolicy considered: vault writes ->
      // grantVault; per-server for MCP; per-kind/per-tool for builtin.
      switch (input.source) {
        case "vault":
          safety.state.grantVault();
          break;
        case "extra-vault":
          if (input.extraVaultRoot)
            safety.state.grantExtraVault(input.extraVaultRoot);
          break;
        case "mcp":
          if (input.toolName) safety.state.grantMcp(input.toolName);
          break;
        case "builtin":
          if (input.toolName) safety.state.grantBuiltin(input.toolName);
          break;
      }
    }

    // Both approve-once and approve-for-session map to SDK approve-once
    // (we manage session grants ourselves to keep policy reentrant).
    return { kind: "approve-once" };
  }

  /**
   * Build the SafetyPolicyInput from an SDK permission request. Source
   * classification rules:
   *   - Our registered write tools (kind=custom-tool, toolName in WRITE_TOOL_NAMES) → `vault`
   *   - MCP (kind=mcp) → `mcp`, toolName=serverName
   *   - Everything else → `builtin`, toolName=kind (or args toolName for custom-tool)
   */
  private buildSafetyInput(
    request: SdkPermissionRequest,
    safety: NonNullable<AgentSessionOptions["safety"]>,
  ): SafetyPolicyInput {
    const kind = request.kind ?? "";
    const toolName = request.toolName;

    if (kind === "custom-tool" && toolName && isWriteToolName(toolName)) {
      const vaultPath =
        safety.extractVaultPath?.(request) ??
        (typeof request.args?.path === "string"
          ? (request.args.path as string)
          : undefined);
      return {
        source: "vault",
        toolName,
        vaultRelativePath: vaultPath,
      };
    }

    if (kind === "mcp") {
      return {
        source: "mcp",
        toolName: request.serverName ?? toolName ?? "(unknown)",
      };
    }

    // Built-in. Key by SDK kind for shell/url/memory/hook/read/write,
    // or by tool name for unregistered custom-tool kinds.
    let key = kind;
    if (kind === "custom-tool" && toolName) key = toolName;
    return { source: "builtin", toolName: key };
  }

  private recordRejection(
    toolCallId: string,
    normalised: PermissionRequest,
    source: "custom" | "mcp" | "builtin",
    argsPreview: string | undefined,
    decision: { decision: "rejected"; reason: string } | SafetyDecisionResult,
  ): SdkPermissionResult {
    const reason = decision.reason;
    const call: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "denied",
      detail: reason,
      argsPreview,
    };
    this.toolCallsThisTurn.push(call);
    this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
    this.currentStreamPush?.({
      type: "tool_call_complete",
      id: toolCallId,
      outcome: "denied",
      errorMessage: reason,
    });
    return { kind: "reject", feedback: reason };
  }

  resolveApproval(toolCallId: string, choice: ApprovalChoice): void {
    const deferred = this.pendingApprovals.get(toolCallId);
    if (!deferred) return;
    this.pendingApprovals.delete(toolCallId);
    deferred.resolve(choice);
  }

  /**
   * Resolve every pending approval with a reject so the SDK never
   * hangs waiting for a user that cannot respond. Called on:
   *   - cancelCurrent (user clicked Stop)
   *   - stream generator early-close / finally
   *   - resetConversation (Clear conversation)
   *   - setToken / reconnect (token rotation)
   *   - dispose (plugin unload)
   */
  private cancelAllPendingApprovals(reason: string): void {
    if (this.pendingApprovals.size === 0) return;
    const reject: ApprovalChoice = { kind: "reject", reason };
    for (const [, deferred] of this.pendingApprovals) {
      deferred.resolve(reject);
    }
    this.pendingApprovals.clear();
  }
}

// ---- helpers ----

/**
 * Classify the source of a tool call for the chat UI. We can't read
 * a single SDK field for this, so we infer from a few signals:
 *   - If the tool name matches one we registered via `opts.tools`, it
 *     is a custom (vault) tool.
 *   - `request.kind === "mcp"` indicates an MCP tool.
 *   - Everything else is a runtime built-in (`shell`, `web_fetch`, …).
 */
export function classifyToolSource(
  kind: string | undefined,
  toolName: string | undefined,
  customNames: Set<string>,
): "custom" | "mcp" | "builtin" {
  // Strongest signal: name matches a tool we registered.
  if (toolName && customNames.has(toolName)) return "custom";
  // SDK kind hints. `custom-tool` is the wire shape for user-defined
  // tools we may have registered under an alias or via overrides.
  if (kind === "custom-tool") return "custom";
  if (kind === "mcp") return "mcp";
  return "builtin";
}

/** Kind-aware args preview for the UI tool-call block. */
function previewArgs(request: SdkPermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText
        ? truncate(request.fullCommandText, 200)
        : undefined;
    case "url":
      return request.url ? truncate(request.url, 200) : undefined;
    case "read":
      return request.path ? `read: ${truncate(request.path, 180)}` : undefined;
    case "write":
      return request.fileName
        ? `write: ${truncate(request.fileName, 180)}`
        : undefined;
    case "memory":
      return request.fact ? truncate(request.fact, 200) : undefined;
    case "custom-tool":
    case "mcp":
      return stringifyArgsForPreview(request.args);
    default: {
      // Legacy fallback used by tests that pass `arguments` directly.
      const raw = (request as { arguments?: unknown }).arguments;
      return stringifyArgsForPreview(raw);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Build a short human-readable summary line for the approval prompt header. */
function buildApprovalSummary(
  request: SdkPermissionRequest,
  input: SafetyPolicyInput,
): string {
  if (input.source === "vault" && input.toolName && input.vaultRelativePath) {
    return `${input.toolName} ${input.vaultRelativePath}`;
  }
  switch (request.kind) {
    case "shell":
      return `Run shell command`;
    case "url":
      return `Fetch URL`;
    case "write":
      return `Write ${request.fileName ?? "(file)"}`;
    case "read":
      return `Read ${request.path ?? "(path)"}`;
    case "memory":
      return `Update memory`;
    case "mcp":
      return `MCP tool ${request.serverName ?? request.toolName ?? ""}`.trim();
    case "custom-tool":
      return `${request.toolName ?? "custom tool"}`;
    default:
      return request.kind ?? "Tool call";
  }
}

/** Build the long-form detail body (e.g. full shell command, URL, args JSON). */
function buildApprovalDetail(
  request: SdkPermissionRequest,
): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText;
    case "url":
      return request.url;
    case "write":
      return request.fileName;
    case "read":
      return request.path;
    case "memory":
      return request.fact;
    case "mcp":
    case "custom-tool":
      return request.args ? safeJson(request.args) : undefined;
    default:
      return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Minimal deferred — resolve only (never rejects, simplifying error paths). */
function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Shared truncation helper for both permission-request and execution_start arg previews. */
function stringifyArgsForPreview(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const s = JSON.stringify(raw);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(raw);
  }
}

function extractText(resp: unknown): string | undefined {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    const data = r.data as Record<string, unknown> | undefined;
    if (data && typeof data.content === "string") return data.content;
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    if (typeof r.message === "string") return r.message;
    const msg = r.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
  }
  return undefined;
}

async function safeCall<T>(
  fn: () => T | Promise<T> | undefined,
): Promise<T | undefined> {
  try {
    const v = fn();
    return await Promise.resolve(v);
  } catch (e) {
    console.warn("[AgentSession] cleanup call threw", e);
    return undefined;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) return true;
  }
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /abort|cancel/i.test(code)) return true;
  }
  return false;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function defaultSdkLoader(): Promise<SdkModule> {
  const mod = (await import("@github/copilot-sdk")) as unknown as SdkModule;
  return mod;
}

// ---- minimal structural SDK shapes (kept local for testability) ----

export interface SdkModule {
  CopilotClient: new (opts: unknown) => SdkClient;
}

export interface SdkModelInfo {
  id?: string;
  policy?: { state?: string };
}

export interface SdkClient {
  start?: () => Promise<void> | void;
  ping?: () => Promise<unknown> | unknown;
  listModels?: () => Promise<SdkModelInfo[]>;
  createSession: (opts: SdkSessionOptions) => Promise<SdkSession>;
  stop?: () => Promise<unknown>;
  forceStop?: () => Promise<void>;
}

export interface SdkSessionOptions {
  model: string;
  availableTools?: string[] | unknown;
  /** Phase 4: opt in to streaming delta events. */
  streaming?: boolean;
  /** Phase 5: custom tools registered with the session. */
  tools?: SdkTool[];
  onPermissionRequest: (
    request: SdkPermissionRequest,
    invocation?: unknown,
  ) => Promise<SdkPermissionResult> | SdkPermissionResult;
}

/** Subset of the SDK's session event we care about for streaming. */
export interface SdkMessageDeltaEvent {
  type: "assistant.message_delta";
  data: { deltaContent: string; messageId?: string };
}

/** Phase 5: tool lifecycle events. */
export interface SdkToolExecutionStartEvent {
  type: "tool.execution_start";
  data: {
    toolCallId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    mcpServerName?: string;
    mcpToolName?: string;
  };
}

export interface SdkToolExecutionCompleteEvent {
  type: "tool.execution_complete";
  data: {
    toolCallId: string;
    success: boolean;
    result?: { content?: string; detailedContent?: string };
    error?: { code?: string; message: string };
  };
}

export interface SdkSession {
  sendAndWait: (prompt: string) => Promise<unknown>;
  abort?: () => Promise<unknown> | unknown;
  disconnect?: () => Promise<unknown> | unknown;
  /**
   * Phase 4/5: subscribe to a specific event type. The SDK returns an
   * unsubscribe function. Modelled structurally so tests can stub it.
   */
  on?: ((
    eventType: "assistant.message_delta",
    handler: (event: SdkMessageDeltaEvent) => void,
  ) => () => void) &
    ((
      eventType: "tool.execution_start",
      handler: (event: SdkToolExecutionStartEvent) => void,
    ) => () => void) &
    ((
      eventType: "tool.execution_complete",
      handler: (event: SdkToolExecutionCompleteEvent) => void,
    ) => () => void);
}

export interface SdkPermissionRequest {
  id?: string;
  /** SDK-canonical correlation id; used as our chat-block id when present. */
  toolCallId?: string;
  kind?: string;
  toolName?: string;
  /** Custom-tool / MCP arguments. */
  args?: Record<string, unknown>;
  /** Built-in `shell` request — full text to execute. */
  fullCommandText?: string;
  /** Built-in `write` request — target file (CLI-relative). */
  fileName?: string;
  /** Built-in `read` request — target path. */
  path?: string;
  /** Built-in `url` request — target URL. */
  url?: string;
  /** Built-in `memory` request — fact being stored / voted. */
  fact?: string;
  /** MCP request — server name. */
  serverName?: string;
  /** Whether the SDK considers session approval valid for this request. */
  canOfferSessionApproval?: boolean;
}

export type SdkPermissionResult =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; feedback: string };
