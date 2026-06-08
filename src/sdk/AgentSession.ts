import type { PermissionDecider } from "../domain/PermissionDecision";
import type { PermissionRequest } from "../domain/types";

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
  /** GitHub token (gho_/ghp_). Phase 2: hardcoded; Phase 3: from AuthController. */
  gitHubToken: string;
  /** COPILOT_HOME for the runtime (we point it at the plugin dir). */
  baseDirectory: string;
  /** Universal-approval-gate decider. Phase 2 = denyAll. */
  decider: PermissionDecider;
  /** Optional: skip listModels and force a specific model id. */
  preferredModel?: string;
  /** Optional: forwarded to the SDK CopilotClient as logLevel. */
  logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
}

/**
 * Public adapter surface. The rest of the codebase consumes this — the
 * concrete CopilotAgentSession encapsulates all SDK interactions.
 */
export interface AgentSession {
  /** Idempotent. Resolves once the SDK is up and a session is created. */
  init(): Promise<void>;
  /** Send a user message and await a single assistant turn. Non-streaming. */
  sendMessage(text: string): Promise<AssistantMessage>;
  /** Reset the SDK session so model context is forgotten. */
  resetConversation(): Promise<void>;
  /** Tear down the SDK session and stop the runtime. Idempotent. */
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
  private disposed = false;
  private toolCallsThisTurn: AssistantToolCall[] = [];
  private readonly sdkLoader: () => Promise<SdkModule>;

  constructor(
    private readonly opts: AgentSessionOptions,
    sdkLoader?: () => Promise<SdkModule>,
  ) {
    this.sdkLoader = sdkLoader ?? defaultSdkLoader;
  }

  getModel(): string | undefined {
    return this.selectedModel;
  }

  init(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("AgentSession disposed"));
    }
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so a future caller can retry with a fresh attempt.
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async sendMessage(text: string): Promise<AssistantMessage> {
    await this.init();
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
    } finally {
      clearTimeout(timer);
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
      onPermissionRequest: (request: SdkPermissionRequest) =>
        this.handlePermission(request),
    });
    this.session = fresh;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.initPromise = null;

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

  // ---- internals ----

  private async doInit(): Promise<void> {
    const sdk = await this.sdkLoader();
    const CopilotClient = sdk.CopilotClient;
    if (!CopilotClient) {
      throw new Error("@github/copilot-sdk does not export CopilotClient");
    }

    const client = new CopilotClient({
      gitHubToken: this.opts.gitHubToken,
      useLoggedInUser: false,
      mode: "empty",
      baseDirectory: this.opts.baseDirectory,
      connection: { kind: "stdio", path: this.opts.cliPath },
      logLevel: this.opts.logLevel ?? "info",
    });

    if (typeof client.start === "function") {
      await client.start();
    }
    if (typeof client.ping === "function") {
      await client.ping();
    }

    this.client = client;

    const model = await this.pickModel(client, this.opts.preferredModel);
    this.selectedModel = model;

    const session = await client.createSession({
      model,
      // Expose all built-in tools so the deny-all decider gets exercised.
      // Phase 6 will replace decider with SafetyPolicy.
      availableTools: ["builtin:*"],
      onPermissionRequest: (request: SdkPermissionRequest) =>
        this.handlePermission(request),
    });
    this.session = session;
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
  onPermissionRequest: (
    request: SdkPermissionRequest,
    invocation?: unknown,
  ) => Promise<SdkPermissionResult> | SdkPermissionResult;
}

export interface SdkSession {
  sendAndWait: (prompt: string) => Promise<unknown>;
  abort?: () => void;
  disconnect?: () => Promise<unknown> | unknown;
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
