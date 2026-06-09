import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Error thrown when a tool-supplied path violates vault-containment
 * invariants (absolute, traversal, escapes-via-symlink, etc.). Callers
 * should surface the `message` to the model as a tool error so the
 * agent learns to avoid the path.
 */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

/**
 * Minimal Vault surface used by VaultPath. We don't import Obsidian's
 * `Vault` type here so this module stays testable with a plain fixture
 * (and the file builds in Node without the Obsidian module being
 * resolvable as a runtime dependency).
 */
export interface VaultLike {
  adapter: { getBasePath?: () => string };
  getAbstractFileByPath?: (path: string) => unknown | null;
  getFileByPath?: (path: string) => unknown | null;
}

/**
 * Resolve a tool-supplied path to an absolute OS path inside the
 * active vault, applying defence-in-depth checks:
 *
 *   1. Reject absolute paths (POSIX `/foo`, Windows `C:\foo`).
 *      Phase 7 will route absolute paths to the extra-vault resolver;
 *      Phase 5 rejects them outright.
 *   2. Reject paths containing `..` segments BEFORE joining, so we
 *      can't be fooled by `inbox/../../../etc` style escapes.
 *   3. Strip a leading slash on relative inputs (`/inbox/x.md` and
 *      `inbox/x.md` resolve to the same vault scope, per plan).
 *   4. Join against the vault root and `path.normalize` to collapse
 *      any leftover `.` segments / double separators.
 *   5. Resolve `fs.realpathSync` on the deepest existing ancestor to
 *      defeat symlinks that point outside the vault.
 *   6. Verify the resolved path is strictly inside the vault root via
 *      `path.relative(root, resolved)` — neither empty (== root) nor
 *      starting with `..` (escape).
 *
 * On any violation, throws `VaultPathError`. Callers translate that
 * into an SDK tool-error response.
 *
 * @param input  Raw path string from the tool argument.
 * @param vault  Active Obsidian vault.
 * @returns      Absolute OS path safe to pass to `fs.*` or compare
 *               against a `TFile.path` lookup.
 */
export function resolveVaultPath(input: string, vault: VaultLike): string {
  if (typeof input !== "string") {
    throw new VaultPathError("Path must be a string.");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new VaultPathError("Path must not be empty.");
  }

  // Windows drive-letter absolute paths (e.g. `C:\foo`) are treated as
  // candidates for extra-vault scope in Phase 7. Phase 5 has no
  // extra-vault wiring, so reject them outright. Detect them regardless
  // of host OS so a malicious tool call from a Windows-aware model
  // can't smuggle one through on POSIX CI.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new VaultPathError(
      `Absolute Windows paths are not allowed in Phase 5 (got "${trimmed}").`,
    );
  }
  // Windows UNC paths (`\\server\share\…`): reject in Phase 5.
  // We only flag backslash-prefixed UNC; POSIX `//foo` is just a
  // doubled forward slash and harmless (normalized below).
  if (/^\\\\[^\\]/.test(trimmed)) {
    throw new VaultPathError(
      `UNC paths are not allowed in Phase 5 (got "${trimmed}").`,
    );
  }

  // Per plan: leading slashes on relative-style inputs are stripped so
  // `inbox/x.md` and `/inbox/x.md` resolve to the same vault scope.
  // The symlink + containment defences below catch any path that
  // actually escapes the vault root regardless of how it was formed.
  const stripped = trimmed.replace(/^[\\/]+/, "");

  // Reject ANY `..` segment BEFORE joining. Doing this on the raw input
  // catches mixed-separator escapes (e.g. `inbox\..\..\etc` on Windows
  // or `inbox/../../etc` on POSIX) that would otherwise be normalised
  // away by `path.normalize` before we could check.
  const segments = stripped.split(/[\\/]+/).filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "..") {
      throw new VaultPathError(
        `Path traversal segments ("..") are not allowed (got "${input}").`,
      );
    }
  }
  if (segments.length === 0) {
    throw new VaultPathError(
      `Path must not refer to the vault root (got "${input}").`,
    );
  }

  const root = getVaultRoot(vault);
  const joined = path.normalize(path.join(root, ...segments));

  // Resolve `realpath` on the deepest existing ancestor. The leaf may
  // not exist yet (e.g. a tool wants to create a new file in Phase 6)
  // so we walk up until we find an existing ancestor — that ancestor's
  // realpath, plus the unresolved tail, is what we ultimately check.
  const realRoot = safeRealpath(root) ?? root;
  const resolved = resolveDeepestExistingAncestor(joined);

  // Final containment check against the real vault root.
  const rel = path.relative(realRoot, resolved);
  if (rel.length === 0) {
    throw new VaultPathError(
      `Path resolves to the vault root, not a child (got "${input}").`,
    );
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultPathError(
      `Path escapes the vault root (got "${input}" → ${resolved}).`,
    );
  }

  return resolved;
}

/**
 * Convert an absolute OS path inside the vault back to Obsidian's
 * vault-relative path form (forward slashes, no leading slash) so it
 * can be passed to `vault.getFileByPath` / `vault.getAbstractFileByPath`.
 */
export function toVaultRelative(absPath: string, vault: VaultLike): string {
  const realRoot = safeRealpath(getVaultRoot(vault)) ?? getVaultRoot(vault);
  const rel = path.relative(realRoot, absPath);
  return rel.split(path.sep).join("/");
}

/**
 * Look up a `TFile`-like by its vault-relative path. Acts as a second
 * line of defence on top of `resolveVaultPath`: the agent can only
 * read files Obsidian itself is tracking.
 */
export function lookupTFile(
  vaultRelativePath: string,
  vault: VaultLike,
): unknown | null {
  if (typeof vault.getFileByPath === "function") {
    const f = vault.getFileByPath(vaultRelativePath);
    if (f) return f;
  }
  if (typeof vault.getAbstractFileByPath === "function") {
    return vault.getAbstractFileByPath(vaultRelativePath);
  }
  return null;
}

// ---- internals ----

function getVaultRoot(vault: VaultLike): string {
  const getBase = vault.adapter?.getBasePath;
  if (typeof getBase !== "function") {
    throw new VaultPathError(
      "Vault adapter does not expose getBasePath(); cannot resolve paths " +
        "on this platform (likely mobile).",
    );
  }
  const root = getBase.call(vault.adapter);
  if (typeof root !== "string" || root.length === 0) {
    throw new VaultPathError("Vault root is empty.");
  }
  return path.resolve(root);
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function resolveDeepestExistingAncestor(p: string): string {
  const segments = p.split(path.sep);
  for (let i = segments.length; i >= 1; i--) {
    const candidate = segments.slice(0, i).join(path.sep);
    if (candidate.length === 0) continue;
    const real = safeRealpath(candidate);
    if (real != null) {
      const tail = segments.slice(i).join(path.sep);
      return tail.length === 0 ? real : path.join(real, tail);
    }
  }
  return p;
}
