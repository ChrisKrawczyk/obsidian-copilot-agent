import { matchDenylist, type ExplicitDenylistOverrideWarning } from "../mcp/stdioEnv";

export { validateMcpHttpUrl, assertNoTlsBypassOptions } from "../mcp/httpPolicy";
export type { HostClass } from "../mcp/httpPolicy";

const TLS_BYPASS_KEYS = ["rejectUnauthorized", "insecure", "skipTls"] as const;

export function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function parseArgsString(raw: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

export function findTlsBypassKey(value: Record<string, unknown>): string | null {
  for (const key of TLS_BYPASS_KEYS) {
    if (Object.hasOwn(value, key)) return key;
  }
  if (value.headers && typeof value.headers === "object") {
    for (const key of TLS_BYPASS_KEYS) {
      if (Object.hasOwn(value.headers as Record<string, unknown>, key)) return key;
    }
  }
  return null;
}

export function collectDenylistWarnings(
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): ExplicitDenylistOverrideWarning[] {
  const caseInsensitive = platform === "win32";
  return Object.keys(env ?? {}).flatMap((key) => {
    const pattern = matchDenylist(key, caseInsensitive);
    return pattern ? [{ key, pattern }] : [];
  });
}

export type { ExplicitDenylistOverrideWarning };
