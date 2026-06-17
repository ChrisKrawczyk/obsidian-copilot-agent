export type HostClass = "loopback" | "private" | "metadata" | "public";

export interface HttpPolicyOptions {
  allowPrivateNetwork?: boolean;
}

export interface HttpPolicyResult {
  url: URL;
  hostClass: HostClass;
  confirmationRequired: boolean;
}

export interface SafeRequestInit extends Omit<RequestInit, "redirect"> {
  redirect?: "manual";
}

export const MAX_REDIRECT_HOPS = 3;

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

export function validateMcpHttpUrl(
  rawUrl: string | URL,
  options: HttpPolicyOptions = {},
): HttpPolicyResult {
  const url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("MCP HTTP URL must use http or https.");
  }
  const hostClass = classifyHost(url.hostname);
  if (hostClass === "metadata") {
    throw new Error("MCP HTTP URL targets a cloud metadata host.");
  }
  if (url.protocol === "http:" && hostClass !== "loopback") {
    throw new Error("MCP HTTP URL must use HTTPS unless it is loopback.");
  }
  if (hostClass === "private" && !options.allowPrivateNetwork) {
    return { url, hostClass, confirmationRequired: true };
  }
  return { url, hostClass, confirmationRequired: false };
}

export function assertNoTlsBypassOptions(init: Record<string, unknown> = {}): void {
  for (const key of ["rejectUnauthorized", "insecure", "skipTls"]) {
    if (Object.hasOwn(init, key)) {
      throw new Error(`TLS bypass option "${key}" is not supported.`);
    }
  }
}

export function validateRedirectHop(
  current: URL,
  location: string,
  hop: number,
  options: HttpPolicyOptions = {},
): { url: URL; crossOrigin: boolean } {
  if (hop > MAX_REDIRECT_HOPS) {
    throw new Error("MCP HTTP redirect limit exceeded.");
  }
  const next = new URL(location, current);
  const validation = validateMcpHttpUrl(next, options);
  if (validation.confirmationRequired && !options.allowPrivateNetwork) {
    throw new Error("MCP HTTP redirect targets a private network.");
  }
  return { url: validation.url, crossOrigin: originOf(current) !== originOf(validation.url) };
}

export function stripCrossOriginAuthHeaders(
  headers: Headers,
  crossOrigin: boolean,
): Headers {
  const next = new Headers(headers);
  if (crossOrigin) {
    next.delete("Authorization");
    next.delete("Mcp-Session-Id");
  }
  return next;
}

export function classifyHost(rawHost: string): HostClass {
  const host = stripIpv6Brackets(rawHost).toLowerCase();
  if (METADATA_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    return "metadata";
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "metadata";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return "private";
    }
    return "public";
  }
  if (host === "localhost" || host === "::1") return "loopback";
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    return "private";
  }
  return "public";
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const pieces = host.split(".");
  if (pieces.length !== 4) return null;
  const octets = pieces.map((piece) => Number(piece));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}
