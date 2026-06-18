export const MCP_TEXT_TRUNCATION_LIMIT = 4096;
export const MCP_TEXT_TRUNCATION_MARKER = "\n… [truncated]";

export function truncateMcpText(
  text: string,
  maxLength = MCP_TEXT_TRUNCATION_LIMIT,
): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}${MCP_TEXT_TRUNCATION_MARKER}`;
}

/**
 * Prepare MCP server-provided text for plain `<pre>.textContent` rendering.
 * `textContent` does not parse HTML and `<pre>` does not parse Markdown, so
 * readability is best preserved by only normalizing line endings and making
 * non-printable control characters visible.
 */
export function escapeMcpPlainText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => {
      return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
}

export function formatMcpApprovalText(value: unknown): string {
  return truncateMcpText(escapeMcpPlainText(value));
}

export function formatMcpJsonText(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  return formatMcpApprovalText(raw);
}
