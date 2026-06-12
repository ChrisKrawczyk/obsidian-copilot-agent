/**
 * v0.4 (model-picker) Phase 2: session-scoped catalog of Copilot models.
 *
 * Wraps `client.listModels()` and exposes a small reactive surface to
 * the UI (Settings dropdown, chat-header picker) and to AgentSession
 * creation.
 *
 * State machine:
 *   loading → ready  (refresh resolved with at least one chat model)
 *   loading → empty  (refresh resolved with zero chat models)
 *   loading → error  (refresh threw or client.listModels missing)
 *   ready   → loading on every refresh (and back to one of the
 *             terminal states above).
 *
 * Exclusion policy (FR-012, mirrored verbatim from
 * ImplementationPlan.md Phase 2 — see plan for justification):
 *   HARD exclusions (the only filters):
 *     - models with `policy.state === "disabled"`
 *     - models with `disabled === true`
 *   SOFT signal (logged, NOT excluded):
 *     - ids matching /embedding|image|dall-e|whisper|tts/i are
 *       `console.warn`-ed for telemetry but pass through unchanged.
 *
 * The catalog is intentionally NOT coupled to any particular
 * conversation. A single shared instance lives at plugin scope; tests
 * can construct ad-hoc instances against fake clients.
 */

import type { SdkClient, SdkModelInfo } from "./AgentSession";

/** Extra fields the SDK may surface on each model record beyond what
 *  AgentSession.SdkModelInfo declared in v0.3. We intentionally keep
 *  this superset local to the catalog — AgentSession's narrow type
 *  remains the contract for the resolver. */
export interface CatalogModelInfo extends SdkModelInfo {
  /** Some SDK builds expose a human-readable name; UI prefers it. */
  name?: string;
  /** Hard-disable bit set by the SDK for kill-switched models. */
  disabled?: boolean;
}

export type ModelCatalogState =
  | { kind: "loading" }
  | { kind: "ready"; models: CatalogModelInfo[]; chatModels: CatalogModelInfo[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type ModelCatalogListener = (state: ModelCatalogState) => void;

const SOFT_SIGNAL_RE = /embedding|image|dall-e|whisper|tts/i;

/**
 * Pure helper. Drops only the HARD-disabled records (policy.state ===
 * "disabled" OR disabled === true). Logs a console.warn for any record
 * whose id matches the soft-signal regex but DOES NOT remove it from
 * the result — this is the regression guard for FR-012.
 */
export function filterChatCapable(
  models: CatalogModelInfo[],
): CatalogModelInfo[] {
  const out: CatalogModelInfo[] = [];
  for (const m of models) {
    if (m.policy?.state === "disabled") continue;
    if (m.disabled === true) continue;
    if (typeof m.id === "string" && SOFT_SIGNAL_RE.test(m.id)) {
      // Soft signal: likely-non-chat id (embedding/image/etc.). We
      // log but keep the record in the list — the SDK is the source of
      // truth on capability, and false-negatives would silently break
      // legitimate chat models whose ids happen to contain these
      // substrings (e.g., a future "gpt-image-reasoning").
      console.warn(
        `[ModelCatalog] soft signal: model id "${m.id}" matches /embedding|image|dall-e|whisper|tts/ — passing through; SDK should be the authority on chat capability.`,
      );
    }
    out.push(m);
  }
  return out;
}

/**
 * Provider for the catalog's underlying SDK client. Returns `null`
 * when the plugin has not yet authenticated (no token, or onload
 * still in progress). The catalog treats `null` the same as a thrown
 * `error` — it transitions to `error` state with a recognisable
 * message so the Settings UI can render a sensible fallback. The
 * indirection lets `main.ts` swap the underlying client on token
 * rotation without re-constructing the catalog (and losing
 * subscribers).
 */
export type ModelCatalogClientProvider = () => SdkClient | null;

export class ModelCatalog {
  private state: ModelCatalogState = { kind: "loading" };
  private listeners = new Set<ModelCatalogListener>();
  /**
   * In-flight refresh promise. We share this across concurrent
   * refresh() callers so a token-rotation refresh that lands on top
   * of the onload refresh doesn't fire two listModels round-trips.
   */
  private inflight: Promise<void> | null = null;

  constructor(private readonly clientProvider: ModelCatalogClientProvider) {}

  getState(): ModelCatalogState {
    return this.state;
  }

  subscribe(fn: ModelCatalogListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Returns true iff the catalog is currently `ready` AND a chat-
   * capable model with this id is present. Anything else (loading,
   * empty, error, unknown id) is `false`.
   *
   * Note: the `null` (Auto sentinel) is OUT OF SCOPE for this method —
   * callers that need to special-case the sentinel must do so before
   * dispatching here.
   */
  isModelAvailable(id: string): boolean {
    if (this.state.kind !== "ready") return false;
    return this.state.chatModels.some((m) => m.id === id);
  }

  /**
   * Re-fetch the model list. Concurrent callers share the in-flight
   * promise; the public `state` always transitions through `loading`
   * exactly once per refresh cycle.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    this.transition({ kind: "loading" });
    const client = this.clientProvider();
    if (!client) {
      this.transition({
        kind: "error",
        message: "Not signed in to Copilot.",
      });
      return;
    }
    if (typeof client.listModels !== "function") {
      this.transition({
        kind: "error",
        message: "SDK client does not expose listModels()",
      });
      return;
    }
    let models: CatalogModelInfo[];
    try {
      const raw = await client.listModels();
      models = Array.isArray(raw) ? (raw as CatalogModelInfo[]) : [];
    } catch (err) {
      this.transition({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const chatModels = filterChatCapable(models);
    if (chatModels.length === 0) {
      this.transition({ kind: "empty" });
      return;
    }
    this.transition({ kind: "ready", models, chatModels });
  }

  private transition(next: ModelCatalogState): void {
    this.state = next;
    for (const fn of this.listeners) {
      try {
        fn(next);
      } catch {
        // Listener errors must not break refresh sequencing.
      }
    }
  }
}
