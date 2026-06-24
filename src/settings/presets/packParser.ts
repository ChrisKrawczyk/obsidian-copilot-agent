import type { PackParseError } from "./packTypes";

export const PACK_MAX_BYTES = 1_048_576; // 1 MB
export const PACK_WARN_BYTES = 102_400; // 100 KB

export interface PackParseOptions {
  /** Override byte length (caller provides when text comes from a known source). */
  byteLength?: number;
  maxBytes?: number;
  warnBytes?: number;
}

export interface PackParseResult {
  ok: boolean;
  raw?: unknown;
  sizeWarning?: boolean;
  error?: PackParseError;
}

/**
 * Parse a preset-pack JSON document.
 *
 * - Strips a leading UTF-8 BOM.
 * - Rejects byte-length > maxBytes BEFORE invoking JSON.parse.
 * - Sets `sizeWarning: true` when byte-length > warnBytes.
 * - Rejects JSON-with-comments (FR-022) — pre-scans for `//` or `/*` outside
 *   string literals (string-aware, NOT a naive regex).
 * - On JSON.parse failure, extracts line/column when present in SyntaxError.
 */
export function parsePackText(
  text: string,
  opts: PackParseOptions = {},
): PackParseResult {
  const maxBytes = opts.maxBytes ?? PACK_MAX_BYTES;
  const warnBytes = opts.warnBytes ?? PACK_WARN_BYTES;
  const byteLength = opts.byteLength ?? Buffer.byteLength(text, "utf8");

  if (byteLength > maxBytes) {
    return {
      ok: false,
      error: {
        kind: "size",
        message: `Pack file exceeds maximum size (${byteLength} bytes > ${maxBytes} bytes).`,
      },
    };
  }

  let stripped = text;
  if (stripped.charCodeAt(0) === 0xfeff) stripped = stripped.slice(1);

  if (stripped.trim().length === 0) {
    return {
      ok: false,
      error: { kind: "parse", message: "Pack file is empty." },
    };
  }

  const commentHit = findCommentOutsideStrings(stripped);
  if (commentHit) {
    return {
      ok: false,
      error: {
        kind: "parse",
        message: "JSON-with-comments is not allowed.",
        line: commentHit.line,
        column: commentHit.column,
      },
    };
  }

  const sizeWarning = byteLength > warnBytes ? true : undefined;

  try {
    const raw = JSON.parse(stripped);
    return { ok: true, raw, ...(sizeWarning ? { sizeWarning } : {}) };
  } catch (err) {
    const { line, column } = extractSyntaxErrorLocation(err, stripped);
    return {
      ok: false,
      error: {
        kind: "parse",
        message: err instanceof Error ? err.message : String(err),
        ...(line != null ? { line } : {}),
        ...(column != null ? { column } : {}),
      },
    };
  }
}

interface CommentHit {
  line: number;
  column: number;
}

/**
 * String-aware comment pre-scan. Honors:
 *   - double-quoted strings with `\` escapes (`"\""` is a single quoted `"`)
 *   - escape sequences in general so `"//"` inside a string is NOT a comment
 *
 * Does NOT honor single-quoted strings (not legal JSON anyway). Stops at the
 * first `//` or `/*` outside a string and returns its 1-based line/column.
 */
function findCommentOutsideStrings(text: string): CommentHit | null {
  let i = 0;
  let line = 1;
  let column = 1;
  let inString = false;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) {
        // Skip the escape and the next character (incl. \n / \uXXXX).
        i += 2;
        column += 2;
        continue;
      }
      if (c === 0x22 /* " */) {
        inString = false;
      }
      if (c === 0x0a) {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
      continue;
    }

    if (c === 0x22) {
      inString = true;
      i++;
      column++;
      continue;
    }
    if (c === 0x2f /* / */ && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x2f || next === 0x2a) {
        return { line, column };
      }
    }
    if (c === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
    i++;
  }
  return null;
}

function extractSyntaxErrorLocation(
  err: unknown,
  text: string,
): { line?: number; column?: number } {
  if (!(err instanceof Error)) return {};
  // Node's JSON.parse error message format varies across versions.
  // V8 includes "at position N" or "at line L column C".
  const lineCol = /at line (\d+) column (\d+)/.exec(err.message);
  if (lineCol) {
    return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
  }
  const pos = /at position (\d+)/.exec(err.message);
  if (pos) {
    return positionToLineColumn(text, Number(pos[1]));
  }
  return {};
}

function positionToLineColumn(
  text: string,
  position: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
