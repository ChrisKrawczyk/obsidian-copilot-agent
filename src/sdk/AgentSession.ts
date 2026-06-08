import type { PermissionDecider } from "../domain/PermissionDecision";
import type { PermissionRequest } from "../domain/types";
import { isAuthError as isAuthErrorLocal } from "../auth/isAuthError";

export interface AssistantMessage {
  /** Rendered text from the model. May be empty if the turn produced only tool errors. */
  content: string;
  /** Tool calls that ran or were rejected during this turn. */
  toolCalls: AssistantToolCall[];
}

export interface AssistantToolCall {
  id: string;
  kind: string;
  name?: string;
  outcome: "denied" | "approved" | "completed" | "errored";
  detail?: string;
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
  /** Universal-approval-gate decider. Phase 2 = denyAll. */
  decider: PermissionDecider;
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
}

/**
 * Normalised stream event surface consumed by the chat view. Insulates
 * the UI from the raw SDK event shape so Phase 5 can extend this (e.g.
 * with `tool_call`) without touching the renderer plumbing.
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; content: string; toolCalls: AssistantToolCall[] };

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
   * Current OAuth token. Mutable so AuthController can rotate it via
   * `setToken()` without rebuilding the AgentSession instance. `null`
   * means "not connected" — init() will reject.
   */
  private currentToken: string | null;
  private toolCallsThisTurn: AssistantToolCall[] = [];
  private readonly sdkLoader: () => Promise<SdkModule>;

  constructor(
    private readonly opts: AgentSessionOptions,
    sdkLoader?: () => Promise<SdkModule>,
  ) {
    this.sdkLoader = sdkLoader ?? defaultSdkLoader;
    this.currentToken = opts.gitHubToken ?? null;
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
      const resp = await this.session.sendAndWait(text);
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

    // Subscribe *before* sending so the first delta isn't lost.
    let unsubDelta: (() => void) | undefined;
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
    }
    const cleanupSubscription = (): void => {
      if (unsubDelta) {
        try {
          unsubDelta();
        } catch (e) {
          console.warn("[AgentSession] unsubscribe delta failed", e);
        }
        unsubDelta = undefined;
      }
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
    session
      .sendAndWait(text)
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
    const session = this.session;
    if (!session || typeof session.abort !== "function") return;
    try {
      await Promise.resolve(session.abort());
    } catch (e) {
      console.warn("[AgentSession] session.abort failed", e);
    }
  }

  async resetConversation(): Promise<void> {
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
      onPermissionRequest: (request: SdkPermissionRequest) =>
        this.handlePermission(request),
    });
    this.session = fresh;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
    const sdk = await this.sdkLoader();
    if (this.disposed) throw new Error("AgentSession disposed during init");
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
    // we MUST tear it down ourselves — dispose() can't see it yet.
    const bailIfDisposed = async (): Promise<void> => {
      if (!this.disposed) return;
      await safeCall(() => client.stop?.());
      throw new Error("AgentSession disposed during init");
    };

    try {
      if (typeof client.start === "function") {
        await client.start();
        await bailIfDisposed();
      }
      if (typeof client.ping === "function") {
        await client.ping();
        await bailIfDisposed();
      }

      this.client = client;

      const model = await this.pickModel(client, this.opts.preferredModel);
      await bailIfDisposed();
      this.selectedModel = model;

      const session = await client.createSession({
        model,
        availableTools: ["builtin:*"],
        streaming: true,
        onPermissionRequest: (request: SdkPermissionRequest) =>
          this.handlePermission(request),
      });
      if (this.disposed) {
        await safeCall(() => session.disconnect?.());
        await safeCall(() => client.stop?.());
        throw new Error("AgentSession disposed during init");
      }
      this.session = session;
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
    const decision = await this.opts.decider(normalised);
    const toolCallId = request.id ?? `tc${Date.now()}`;
    if (decision.kind === "reject") {
      this.toolCallsThisTurn.push({
        id: toolCallId,
        kind: normalised.kind,
        name: normalised.toolName,
        outcome: "denied",
        detail: decision.feedback,
      });
      return { kind: "reject", feedback: decision.feedback ?? "Denied." };
    }
    this.toolCallsThisTurn.push({
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      outcome: "approved",
    });
    return { kind: decision.kind };
  }
}

// ---- helpers ----

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

export interface SdkSession {
  sendAndWait: (prompt: string) => Promise<unknown>;
  abort?: () => Promise<unknown> | unknown;
  disconnect?: () => Promise<unknown> | unknown;
  /**
   * Phase 4: subscribe to a specific event type. The SDK returns an
   * unsubscribe function. Modelled structurally so tests can stub it.
   */
  on?: (
    eventType: "assistant.message_delta",
    handler: (event: SdkMessageDeltaEvent) => void,
  ) => () => void;
}

export interface SdkPermissionRequest {
  id?: string;
  kind?: string;
  toolName?: string;
}

export type SdkPermissionResult =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; feedback: string };
