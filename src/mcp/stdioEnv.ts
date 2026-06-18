export interface StdioEnvOptions {
  inheritedEnv?: NodeJS.ProcessEnv;
  explicitEnv?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export interface ExplicitDenylistOverrideWarning {
  key: string;
  pattern: string;
}

export interface StdioEnvResult {
  env: Record<string, string>;
  explicitDenylistOverrides: ExplicitDenylistOverrideWarning[];
}

const EXACT_DENYLIST = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SSH_AUTH_SOCK",
  "SSH_PRIVATE_KEY",
]);

const PREFIX_DENYLIST = ["COPILOT_", "COPILOT_AGENT_", "AZURE_OPENAI_", "AWS_", "GCP_"];
const SUFFIX_DENYLIST = ["_TOKEN", "_API_KEY", "_SECRET", "_PASSWORD"];
const MAC_PATH_PREPEND = ["/usr/local/bin", "/opt/homebrew/bin"];

export function buildStdioEnv(options: StdioEnvOptions = {}): StdioEnvResult {
  const platform = options.platform ?? process.platform;
  const caseInsensitive = platform === "win32";
  const inherited = options.inheritedEnv ?? process.env;
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (matchDenylist(key, caseInsensitive)) continue;
    env[key] = value;
  }

  if (platform === "darwin") {
    const pathKey = findEnvKey(env, "PATH", caseInsensitive) ?? "PATH";
    env[pathKey] = prependMacPath(env[pathKey] ?? "");
  }

  const explicitDenylistOverrides: ExplicitDenylistOverrideWarning[] = [];
  for (const [key, value] of Object.entries(options.explicitEnv ?? {})) {
    const match = matchDenylist(key, caseInsensitive);
    if (match) explicitDenylistOverrides.push({ key, pattern: match });
    const existingKey = findEnvKey(env, key, caseInsensitive);
    if (existingKey && existingKey !== key) delete env[existingKey];
    env[key] = value;
  }

  return { env, explicitDenylistOverrides };
}

export function matchDenylist(
  key: string,
  caseInsensitive = process.platform === "win32",
): string | null {
  const normalized = caseInsensitive ? key.toUpperCase() : key;
  if (EXACT_DENYLIST.has(normalized)) return normalized;
  for (const prefix of PREFIX_DENYLIST) {
    if (normalized.startsWith(prefix)) return `${prefix}*`;
  }
  for (const suffix of SUFFIX_DENYLIST) {
    if (normalized.endsWith(suffix)) return `*${suffix}`;
  }
  return null;
}

function findEnvKey(
  env: Record<string, string>,
  key: string,
  caseInsensitive: boolean,
): string | undefined {
  if (!caseInsensitive) return Object.hasOwn(env, key) ? key : undefined;
  const wanted = key.toUpperCase();
  return Object.keys(env).find((entry) => entry.toUpperCase() === wanted);
}

function prependMacPath(existing: string): string {
  const pieces = existing.length > 0 ? existing.split(":") : [];
  const deduped = pieces.filter((entry) => !MAC_PATH_PREPEND.includes(entry));
  return [...MAC_PATH_PREPEND, ...deduped].join(":");
}
