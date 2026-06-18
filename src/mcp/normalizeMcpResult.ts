import { truncateMcpText } from "../sdk/approvalText";
import { redactSensitive } from "./redactSensitive";

export interface NormalizedMcpResult {
  content: string;
  isError: boolean;
  errorKind?: "json-rpc" | "mcp";
}

export function normalizeMcpResult(value: unknown): NormalizedMcpResult {
  const isJsonRpcError = Boolean(value && typeof value === "object" && "error" in value);
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const isMcpError = record?.isError === true;
  const source = isJsonRpcError ? (record?.error as unknown) : value;
  const content = normalizeValue(source);
  return {
    content: truncateMcpText(redactSensitive(content)),
    isError: isJsonRpcError || isMcpError,
    ...(isJsonRpcError ? { errorKind: "json-rpc" as const } : isMcpError ? { errorKind: "mcp" as const } : {}),
  };
}

export function normalizeMcpArgs(value: unknown): string {
  return truncateMcpText(redactSensitive(stringify(value)));
}

function normalizeValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeContentItem).filter(Boolean).join("\n\n");
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const parts = record.content.map(normalizeContentItem).filter(Boolean);
    if (record.structuredContent !== undefined) parts.push(`structuredContent:\n${stringify(record.structuredContent)}`);
    return parts.join("\n\n");
  }
  if (record.structuredContent !== undefined) return stringify(record.structuredContent);
  if (record.message !== undefined || record.code !== undefined) return stringify(record);
  return stringify(value);
}

function normalizeContentItem(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item !== "object") return String(item);
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text") return typeof record.text === "string" ? record.text : stringify(record);
  if (type === "resource_link" || type === "resourceLink") return `resource link: ${stringify(record)}`;
  if (type === "resource" || record.resource) {
    const resource = (record.resource && typeof record.resource === "object" ? record.resource : record) as Record<string, unknown>;
    if (isBinaryResource(resource)) return binaryPlaceholder("resource", resource);
    return `resource: ${stringify(resource)}`;
  }
  if (type === "image" || type === "audio" || type === "blob") return binaryPlaceholder(type, record);
  if (typeof record.mimeType === "string" && typeof record.data === "string") return binaryPlaceholder("blob", record);
  return stringify(record);
}

function isBinaryResource(record: Record<string, unknown>): boolean {
  const mime = String(record.mimeType ?? record.mime ?? "");
  return Boolean(record.blob || record.data || record.bytes) && !mime.startsWith("text/");
}

function binaryPlaceholder(kind: string, record: Record<string, unknown>): string {
  const mime = String(record.mimeType ?? record.mime ?? "application/octet-stream");
  const data = typeof record.data === "string" ? record.data : typeof record.blob === "string" ? record.blob : "";
  const bytes = decodedBase64Length(data);
  return `[${kind}: ${mime}, ${bytes} bytes]`;
}

function decodedBase64Length(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
