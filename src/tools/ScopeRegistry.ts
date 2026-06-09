// ScopeRegistry: classifies a tool-call target path into a scope bucket.
// Phase 6 only supports vault scope. Phase 7 will add extra-vault roots.
//
// This is a pure module. It does not perform I/O or require an Obsidian
// vault adapter — it is given an already-resolved absolute path and a
// vault root and returns a classification. Callers (WriteTools handlers,
// SafetyPolicy classifier) feed in paths produced by VaultPath.

export type ScopeKind = "vault" | "extra-vault" | "outside";

export interface ScopeClassification {
  kind: ScopeKind;
  /**
   * Vault-relative path when `kind === "vault"`. For `extra-vault` /
   * `outside`, undefined (Phase 7 will populate a root-relative path
   * for extra-vault entries).
   */
  vaultRelativePath?: string;
}

export interface ScopeRegistryLike {
  classify(absolutePath: string): ScopeClassification;
}

/**
 * Phase 6 implementation: only the vault is a recognised scope. Any
 * path outside the vault root is classified as `outside`. Phase 7 will
 * add a list of extra-vault roots and an `extra-vault` classification
 * with a `rootId` field used for SafetyPolicy grant scoping.
 */
export class VaultOnlyScopeRegistry implements ScopeRegistryLike {
  constructor(private readonly vaultRoot: string) {}

  classify(absolutePath: string): ScopeClassification {
    const normalisedRoot = normalisePath(this.vaultRoot);
    const normalisedTarget = normalisePath(absolutePath);
    if (
      normalisedTarget === normalisedRoot ||
      normalisedTarget.startsWith(normalisedRoot + "/")
    ) {
      const rel =
        normalisedTarget === normalisedRoot
          ? ""
          : normalisedTarget.slice(normalisedRoot.length + 1);
      return { kind: "vault", vaultRelativePath: rel };
    }
    return { kind: "outside" };
  }
}

function normalisePath(p: string): string {
  // Convert to forward slashes for portable comparison, strip trailing /.
  let n = p.replace(/\\/g, "/");
  while (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
