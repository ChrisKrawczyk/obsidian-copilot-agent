/**
 * Orchestrates the GitHub auth lifecycle: Device Flow + token persistence
 * + agent token rotation, exposed as a small state machine.
 *
 * State graph:
 *   disconnected ──connect()──▶ connecting ──code received──▶ connecting (with verification)
 *                                  │ token granted
 *                                  ▼
 *                              validating ──ok──▶ connected
 *                                  │ fail
 *                                  ▼
 *                                error
 *   connecting ──cancelConnect()──▶ disconnected
 *   any         ──disconnect()──▶ disconnected
 *   error       ──connect()──▶ connecting
 *
 * Concurrency: state transitions are checked + applied SYNCHRONOUSLY at
 * the top of each mutator, before any await. Two simultaneous connect()
 * calls cannot both observe `disconnected`. We don't use a queue lock
 * because Device Flow polling is long — queueing a disconnect behind a
 * connect would defeat the cancel button.
 */

import {
  DEFAULT_SCOPE,
  DeviceFlowError,
  GH_CLI_CLIENT_ID,
  type DeviceCodeResponse,
  runDeviceFlow,
} from "./DeviceFlow";
import type { HttpClient } from "./HttpClient";
import { isAuthError } from "./isAuthError";
import type { TokenStore } from "./TokenStore";

export type AuthState =
  | { kind: "disconnected" }
  | {
      kind: "connecting";
      /** Populated once we have a device code from GitHub. */
      verification?: DeviceCodeResponse;
    }
  | { kind: "validating"; tokenPreview: string }
  | { kind: "connected"; tokenPreview: string; model?: string }
  | { kind: "error"; message: string; retryable: boolean };

export interface AuthControllerDeps {
  http: HttpClient;
  tokenStore: TokenStore;
  /** Adapter onto the SDK runtime. Allows token swap + validation. */
  agentTokenSink: AgentTokenSink;
  clientId?: string;
  scope?: string;
}

/**
 * The minimum surface AuthController needs from AgentSession. Lets tests
 * supply a fake without dragging the SDK in.
 */
export interface AgentTokenSink {
  /**
   * Swap the token. Stops the current SDK runtime (without disposing
   * the AgentSession permanently). Pass `null` to disconnect.
   */
  setToken(token: string | null): Promise<void>;
  /**
   * Force a fresh init using the current token. Throws on auth error
   * (including 401/403 from listModels). Returns the resolved model id
   * so we can show it in the UI.
   */
  reconnect(): Promise<string | undefined>;
}

type Listener = (state: AuthState) => void;

export class AuthController {
  private state: AuthState = { kind: "disconnected" };
  private listeners = new Set<Listener>();
  private connectAbort: AbortController | null = null;
  /** Tracks the active connect run so disconnect can wait for cleanup. */
  private connectRun: Promise<void> | null = null;

  constructor(private readonly deps: AuthControllerDeps) {}

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Fire once with current state so subscribers can prime their UI.
    try {
      listener(this.state);
    } catch (e) {
      console.warn("[AuthController] subscriber threw", e);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Hydrate from disk on plugin load. If a token was persisted we move
   * straight to `validating` and either land on `connected` or `error`.
   */
  async hydrate(): Promise<void> {
    const snap = this.deps.tokenStore.snapshot();
    if (!snap.token) {
      this.setState({ kind: "disconnected" });
      return;
    }
    this.setState({ kind: "validating", tokenPreview: previewToken(snap.token) });
    try {
      await this.deps.agentTokenSink.setToken(snap.token);
      const model = await this.deps.agentTokenSink.reconnect();
      this.setState({
        kind: "connected",
        tokenPreview: previewToken(snap.token),
        model,
      });
    } catch (err) {
      if (isAuthError(err)) {
        // Persisted token is no longer valid (revoked, expired). Wipe it
        // so we don't keep retrying on every restart.
        await this.deps.tokenStore.setToken(null).catch(() => {});
        await this.deps.agentTokenSink.setToken(null).catch(() => {});
        this.setState({
          kind: "error",
          message:
            "Saved token was rejected by GitHub. Click Connect to re-authenticate.",
          retryable: true,
        });
      } else {
        this.setState({
          kind: "error",
          message: errMsg(err),
          retryable: true,
        });
      }
    }
  }

  /** Start the OAuth Device Flow. */
  async connect(): Promise<void> {
    // Synchronous gate — only allow from disconnected/error so two parallel
    // calls can't both kick off device flows.
    if (this.state.kind !== "disconnected" && this.state.kind !== "error") {
      throw new Error(
        `Cannot connect from state '${this.state.kind}'. Disconnect first.`,
      );
    }
    const abort = new AbortController();
    this.connectAbort = abort;
    this.setState({ kind: "connecting" });

    const run = this.runConnect(abort.signal).catch((err) => {
      console.error("[AuthController] connect failed", err);
    });
    this.connectRun = run;
    try {
      await run;
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null;
      if (this.connectRun === run) this.connectRun = null;
    }
  }

  /** User clicked Cancel on the device-flow modal. */
  cancelConnect(): void {
    if (this.state.kind !== "connecting") return;
    this.connectAbort?.abort();
    // The connect run will catch the abort and transition itself to
    // disconnected. We don't await here so the UI remains responsive.
  }

  /** Drop the token, abort any in-flight session, return to disconnected. */
  async disconnect(): Promise<void> {
    // Abort an active connect first.
    if (this.connectAbort) {
      this.connectAbort.abort();
      // Wait briefly for connect's cleanup so we don't race its setState.
      try {
        await this.connectRun;
      } catch {
        /* swallow — connect already logged */
      }
    }
    this.setState({ kind: "disconnected" });
    await this.deps.agentTokenSink.setToken(null).catch((e) =>
      console.warn("[AuthController] agent setToken(null) threw", e),
    );
    await this.deps.tokenStore.setToken(null).catch((e) =>
      console.warn("[AuthController] tokenStore.setToken(null) threw", e),
    );
  }

  /**
   * Toggle persistence. The TokenStore handles the on-disk wipe; we don't
   * touch the in-memory agent token (the user is still mid-session).
   */
  async setPersistEnabled(enabled: boolean): Promise<void> {
    await this.deps.tokenStore.setPersistEnabled(enabled);
  }

  /**
   * Called by AgentSession when a send fails with an auth error. We do
   * NOT auto-reconnect — we just transition to `error` so the UI can
   * prompt the user to reconnect manually. Silent reconnect risks loops
   * if the token has been revoked server-side.
   */
  notifyAuthFailure(err: unknown): void {
    if (this.state.kind === "connected" || this.state.kind === "validating") {
      this.setState({
        kind: "error",
        message: `GitHub rejected the saved token: ${errMsg(err)}. Click Reconnect.`,
        retryable: true,
      });
    }
  }

  // ---- internals ----

  private async runConnect(signal: AbortSignal): Promise<void> {
    let token: string;
    try {
      const result = await runDeviceFlow({
        http: this.deps.http,
        clientId: this.deps.clientId ?? GH_CLI_CLIENT_ID,
        scope: this.deps.scope ?? DEFAULT_SCOPE,
        signal,
        onDeviceCode: (code) => {
          // Re-emit state with verification details for the modal.
          if (this.state.kind === "connecting") {
            this.setState({ kind: "connecting", verification: code });
          }
        },
      });
      token = result.token;
    } catch (err) {
      if (err instanceof DeviceFlowError) {
        if (err.code === "aborted" || err.code === "access_denied") {
          this.setState({ kind: "disconnected" });
          return;
        }
        this.setState({
          kind: "error",
          message: err.message,
          retryable: true,
        });
        return;
      }
      this.setState({ kind: "error", message: errMsg(err), retryable: true });
      return;
    }

    if (signal.aborted) {
      this.setState({ kind: "disconnected" });
      return;
    }

    this.setState({ kind: "validating", tokenPreview: previewToken(token) });
    try {
      await this.deps.tokenStore.setToken(token);
      await this.deps.agentTokenSink.setToken(token);
      const model = await this.deps.agentTokenSink.reconnect();
      this.setState({
        kind: "connected",
        tokenPreview: previewToken(token),
        model,
      });
    } catch (err) {
      // Validation failed — token may be valid for OAuth but not Copilot.
      // Don't keep an unusable token around.
      await this.deps.tokenStore.setToken(null).catch(() => {});
      await this.deps.agentTokenSink.setToken(null).catch(() => {});
      this.setState({
        kind: "error",
        message: isAuthError(err)
          ? `GitHub accepted the OAuth grant but Copilot rejected the token (${errMsg(err)}). Your account may not have Copilot access.`
          : `Failed to validate token: ${errMsg(err)}`,
        retryable: true,
      });
    }
  }

  private setState(state: AuthState): void {
    this.state = state;
    for (const l of this.listeners) {
      try {
        l(state);
      } catch (e) {
        console.warn("[AuthController] listener threw", e);
      }
    }
  }
}

function previewToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
