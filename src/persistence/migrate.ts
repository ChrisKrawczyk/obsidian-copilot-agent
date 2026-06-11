/**
 * Schema migration for the persisted `conversations` subtree.
 *
 * Migration policy contract (stable extension point for v0.4+):
 *
 *   migrate(raw) returns:
 *     - { state, recovered: false } when `raw.schemaVersion` is a known
 *       version and the payload validates per that version's shape.
 *     - { state: DEFAULT_CONVERSATIONS_STATE, recovered: true } when
 *       `raw.schemaVersion` is missing, unknown, or the payload is
 *       structurally invalid for its declared version. The caller
 *       (ConversationsStore.load) writes the malformed subtree to a
 *       sibling backup file and surfaces a Notice.
 *
 * v0.3 only knows `schemaVersion === 1`. Future versions will add
 * stepwise transformers (e.g. v1 → v2) called in sequence; the
 * recovery path is the fallback when a forward-only client meets a
 * future blob it cannot read (downgrade scenario).
 */

import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_CONVERSATIONS_STATE,
  type PersistedConversation,
  type PersistedConversationsState,
  type PersistedMessage,
  type PersistedUndoEntry,
} from "./PersistedShape";

export interface MigrateResult {
  state: PersistedConversationsState;
  recovered: boolean;
  /** When recovered === true, the malformed subtree the caller
   *  should write to the recovery sidecar. May be `null` if the input
   *  was nullish. */
  malformed?: unknown;
}

export function migrate(raw: unknown): MigrateResult {
  if (raw == null || typeof raw !== "object") {
    return { state: cloneDefault(), recovered: false };
  }

  const obj = raw as Record<string, unknown>;
  const version = obj.schemaVersion;

  if (version !== CURRENT_SCHEMA_VERSION) {
    return {
      state: cloneDefault(),
      recovered: true,
      malformed: raw,
    };
  }

  const validated = validateV1(obj);
  if (!validated) {
    return {
      state: cloneDefault(),
      recovered: true,
      malformed: raw,
    };
  }
  return { state: validated, recovered: false };
}

function cloneDefault(): PersistedConversationsState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversations: [],
    activeConversationId: null,
  };
}

function validateV1(obj: Record<string, unknown>): PersistedConversationsState | null {
  const conversationsRaw = obj.conversations;
  if (!Array.isArray(conversationsRaw)) return null;

  const conversations: PersistedConversation[] = [];
  for (const c of conversationsRaw) {
    const validated = validateConversation(c);
    if (!validated) return null;
    conversations.push(validated);
  }

  const activeRaw = obj.activeConversationId;
  const activeConversationId =
    typeof activeRaw === "string" ? activeRaw : activeRaw === null ? null : null;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversations,
    activeConversationId,
  };
}

function validateConversation(raw: unknown): PersistedConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) return null;
  if (typeof c.name !== "string") return null;
  if (typeof c.createdAt !== "number") return null;
  if (typeof c.lastActiveAt !== "number") return null;
  if (!Array.isArray(c.messages)) return null;
  if (!Array.isArray(c.undoEntries)) return null;

  const messages: PersistedMessage[] = [];
  for (const m of c.messages) {
    const validated = validateMessage(m);
    if (!validated) return null;
    messages.push(validated);
  }
  const undoEntries: PersistedUndoEntry[] = [];
  for (const e of c.undoEntries) {
    const validated = validateUndoEntry(e);
    if (!validated) return null;
    undoEntries.push(validated);
  }

  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
    archived: c.archived === true,
    messages,
    undoEntries,
  };
}

function validateMessage(raw: unknown): PersistedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string") return null;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return null;
  if (typeof m.content !== "string") return null;
  if (
    m.status !== "complete" &&
    m.status !== "interrupted" &&
    m.status !== "error"
  ) {
    return null;
  }
  if (typeof m.createdAt !== "number") return null;

  const out: PersistedMessage = {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
  };

  if (m.toolCalls !== undefined) {
    if (!Array.isArray(m.toolCalls)) return null;
    const calls: NonNullable<PersistedMessage["toolCalls"]> = [];
    for (const tc of m.toolCalls) {
      if (!tc || typeof tc !== "object") return null;
      const t = tc as Record<string, unknown>;
      if (typeof t.id !== "string") return null;
      if (typeof t.kind !== "string") return null;
      const outcome = t.outcome;
      if (
        outcome !== "denied" &&
        outcome !== "approved" &&
        outcome !== "completed" &&
        outcome !== "errored"
      ) {
        return null;
      }
      calls.push({
        id: t.id,
        kind: t.kind,
        name: typeof t.name === "string" ? t.name : undefined,
        source:
          t.source === "custom" ||
          t.source === "mcp" ||
          t.source === "builtin"
            ? t.source
            : undefined,
        outcome,
        detail: typeof t.detail === "string" ? t.detail : undefined,
        argsPreview:
          typeof t.argsPreview === "string" ? t.argsPreview : undefined,
        resultContent:
          typeof t.resultContent === "string" ? t.resultContent : undefined,
        undoId: typeof t.undoId === "string" ? t.undoId : undefined,
        undone: t.undone === true ? true : undefined,
      });
    }
    out.toolCalls = calls;
  }

  return out;
}

function validateUndoEntry(raw: unknown): PersistedUndoEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string") return null;
  if (e.kind !== "create" && e.kind !== "modify" && e.kind !== "delete") return null;
  if (e.scope !== "vault" && e.scope !== "extra-vault") return null;
  if (typeof e.path !== "string") return null;
  if (typeof e.recordedAt !== "number") return null;
  return {
    id: e.id,
    kind: e.kind,
    scope: e.scope,
    path: e.path,
    before: typeof e.before === "string" ? e.before : undefined,
    after: typeof e.after === "string" ? e.after : undefined,
    recordedAt: e.recordedAt,
    undone: e.undone === true ? true : undefined,
  };
}

void DEFAULT_CONVERSATIONS_STATE;
