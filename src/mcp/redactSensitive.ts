const REDACTED = "[REDACTED]";

const ENV_KEY_PATTERN =
  /^(?:GITHUB_TOKEN|GH_TOKEN|COPILOT_[A-Z0-9_]*|OPENAI_API_KEY|ANTHROPIC_API_KEY|AZURE_OPENAI_[A-Z0-9_]*|AWS_[A-Z0-9_]*|GCP_[A-Z0-9_]*|[A-Z0-9_]+_(?:TOKEN|API_KEY|SECRET|PASSWORD))$/i;

const TOKEN_QUERY_KEYS =
  /(?:access_token|token|api[_-]?key|key|authorization|auth[_-]?token|secret|password)/i;

export function redactSensitive(text: string): string {
  let redacted = String(text ?? "");

  redacted = redacted.replace(
    /\b(Authorization\s*[:=]\s*)([^\r\n]+)/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(/\bBearer\s+([A-Za-z0-9._~+/\-=]+)/gi, `Bearer ${REDACTED}`);
  redacted = redacted.replace(
    /\b(Mcp-Session-Id\s*[:=]\s*)([^\s&]+)/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /([?&](?:mcp[-_]?session[-_]?id)=)([^&#\s]+)/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(https?:\/\/)([^\/\s:@]+(?::[^\/\s@]*)?@)/gi,
    `$1${REDACTED}@`,
  );
  redacted = redacted.replace(
    /([?&])([^=&#\s]+)=([^&#\s]*)/g,
    (match, sep: string, key: string) =>
      TOKEN_QUERY_KEYS.test(key) ? `${sep}${key}=${REDACTED}` : match,
  );

  redacted = redacted
    .split(/\n/)
    .map((line) =>
      line.replace(
        /^(\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*)(.*)$/i,
        (match, prefix: string, key: string) =>
          ENV_KEY_PATTERN.test(key) ? `${prefix}${REDACTED}` : match,
      ),
    )
    .join("\n");

  return redacted;
}
