import type { Plugin } from "obsidian";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as https from "node:https";
import * as http from "node:http";
import * as child_process from "node:child_process";
import { getAbsolutePluginDir } from "./resolveCliBinaryPath";

export type PlatformOs = "darwin" | "linux" | "linuxmusl" | "win32";
export type PlatformArch = "x64" | "arm64";

export interface PlatformTuple {
  os: PlatformOs;
  arch: PlatformArch;
  /** Final binary basename in the plugin directory. */
  binaryName: string;
  /** npm package name for this tuple, e.g. "@github/copilot-win32-x64". */
  npmPkg: string;
}

export type FetcherErrorKind =
  | "unsupported-platform"
  | "network"
  | "integrity"
  | "extract"
  | "filesystem"
  | "registry";

export class FetcherError extends Error {
  constructor(
    readonly kind: FetcherErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FetcherError";
  }
}

export interface PlatformProbe {
  platform: NodeJS.Platform;
  arch: string;
  /** Returns "glibc" | "musl" | "unknown". Linux-only; ignored elsewhere. */
  probeLinuxLibc: () => "glibc" | "musl" | "unknown";
}

/** Live OS probe used in production. */
export function createDefaultProbe(): PlatformProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    probeLinuxLibc: () => probeLinuxLibcLive(),
  };
}

function probeLinuxLibcLive(): "glibc" | "musl" | "unknown" {
  try {
    const report = (process as unknown as { report?: { getReport?: () => unknown } })
      .report;
    const r = report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (r?.header?.glibcVersionRuntime) return "glibc";
  } catch {
    // fall through to ldd
  }
  try {
    const out = child_process
      .execSync("ldd --version 2>&1", { encoding: "utf8", timeout: 2000 })
      .toString();
    if (/musl/i.test(out)) return "musl";
    if (/GLIBC|GNU\s+libc|GNU C Library/i.test(out)) return "glibc";
  } catch {
    // fall through
  }
  return "unknown";
}

const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

export function detectPlatformTuple(probe: PlatformProbe = createDefaultProbe()): PlatformTuple {
  if (!SUPPORTED_ARCHES.has(probe.arch)) {
    throw new FetcherError(
      "unsupported-platform",
      `Unsupported CPU arch "${probe.arch}". Copilot CLI ships only for x64 and arm64. ` +
        `Please file an issue with your platform details (process.platform="${probe.platform}", process.arch="${probe.arch}").`,
    );
  }
  const arch = probe.arch as PlatformArch;

  if (probe.platform === "win32") {
    return { os: "win32", arch, binaryName: "copilot.exe", npmPkg: `@github/copilot-win32-${arch}` };
  }
  if (probe.platform === "darwin") {
    return { os: "darwin", arch, binaryName: "copilot", npmPkg: `@github/copilot-darwin-${arch}` };
  }
  if (probe.platform === "linux") {
    const libc = probe.probeLinuxLibc();
    if (libc === "glibc") {
      return { os: "linux", arch, binaryName: "copilot", npmPkg: `@github/copilot-linux-${arch}` };
    }
    if (libc === "musl") {
      return { os: "linuxmusl", arch, binaryName: "copilot", npmPkg: `@github/copilot-linuxmusl-${arch}` };
    }
    throw new FetcherError(
      "unsupported-platform",
      `Could not determine Linux libc flavor (neither glibcVersionRuntime nor ldd succeeded). ` +
        `Please file an issue with your platform details (process.platform="${probe.platform}", process.arch="${probe.arch}").`,
    );
  }
  throw new FetcherError(
    "unsupported-platform",
    `Unsupported OS "${probe.platform}". Copilot CLI ships only for darwin, linux, linuxmusl, and win32. ` +
      `Please file an issue with your platform details (process.arch="${probe.arch}").`,
  );
}

/** Marker file basename written next to the binary to record installed version. */
export const MARKER_FILE = ".copilot-binary-version";

/** Synchronous resolution of the final binary path; mirrors resolveCliBinaryPath. */
export function getRequiredBinaryPath(plugin: Plugin, probe: PlatformProbe = createDefaultProbe()): string {
  const dir = resolvePluginDirOrThrow(plugin);
  const tuple = detectPlatformTuple(probe);
  return path.join(dir, tuple.binaryName);
}

export function getMarkerPath(plugin: Plugin): string {
  const dir = resolvePluginDirOrThrow(plugin);
  return path.join(dir, MARKER_FILE);
}

function resolvePluginDirOrThrow(plugin: Plugin): string {
  const dir = getAbsolutePluginDir(plugin);
  if (!dir) {
    throw new FetcherError(
      "filesystem",
      "Could not determine the absolute plugin directory. Is this an Obsidian Desktop install?",
    );
  }
  return dir;
}

/**
 * Check installation state strictly per Spec FR-020 + planning-docs-review C1:
 *   - Binary missing → false
 *   - Binary present + marker missing → false (re-fetch; no trust-and-record fallback)
 *   - Binary present + marker present but version-mismatched → false (re-fetch)
 *   - Binary present + marker matches pinned version → true
 */
export function isInstalled(
  plugin: Plugin,
  pinnedVersion: string,
  probe: PlatformProbe = createDefaultProbe(),
): boolean {
  const binaryPath = getRequiredBinaryPath(plugin, probe);
  if (!fs.existsSync(binaryPath)) return false;
  const markerPath = getMarkerPath(plugin);
  if (!fs.existsSync(markerPath)) return false;
  let markerContent: string;
  try {
    markerContent = fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    return false;
  }
  return markerContent === pinnedVersion;
}

export type ProgressFn = (bytes: number, total: number | null) => void;

/**
 * Internal seam used by tests to inject a fake HTTPS getter and/or libc probe.
 * Production callers omit `deps`.
 */
export interface FetcherDeps {
  probe?: PlatformProbe;
  /**
   * Fetches a URL and returns headers + a Buffer body. Implementations must
   * follow redirects (npm registry tarballs are served via redirects).
   */
  httpGet?: (url: string) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  /** Override registry origin (default "https://registry.npmjs.org"). */
  registryOrigin?: string;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MAX_REDIRECTS = 5;

function liveHttpGet(
  url: string,
  redirectsLeft = MAX_REDIRECTS,
  onChunk?: (received: number, total: number | null) => void,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolveP, rejectP) => {
    try {
      const lib = url.startsWith("https:") ? https : http;
      const r = lib.get(url, (res) => {
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
        }
        if (status >= 300 && status < 400 && headers["location"] && redirectsLeft > 0) {
          res.resume();
          liveHttpGet(headers["location"], redirectsLeft - 1, onChunk).then(resolveP, rejectP);
          return;
        }
        const totalHeader = headers["content-length"];
        const total = totalHeader ? Number(totalHeader) : null;
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (onChunk) onChunk(received, total);
        });
        res.on("end", () => resolveP({ status, headers, body: Buffer.concat(chunks) }));
        res.on("error", rejectP);
      });
      r.on("error", rejectP);
    } catch (err) {
      rejectP(err);
    }
  });
}

/**
 * Main entry point. Returns the absolute path to the binary on success.
 * Throws FetcherError on any failure; leaves no partial artifact at the
 * final path (atomic rename of a fully-extracted, verified, chmod'd file).
 */
export async function ensureInstalled(
  plugin: Plugin,
  pinnedVersion: string,
  onProgress?: ProgressFn,
  deps: FetcherDeps = {},
): Promise<string> {
  const probe = deps.probe ?? createDefaultProbe();
  if (isInstalled(plugin, pinnedVersion, probe)) {
    return getRequiredBinaryPath(plugin, probe);
  }

  const tuple = detectPlatformTuple(probe);
  const pluginDir = resolvePluginDirOrThrow(plugin);
  const finalBinaryPath = path.join(pluginDir, tuple.binaryName);
  const markerPath = path.join(pluginDir, MARKER_FILE);

  const httpGet = deps.httpGet ?? ((url: string) => liveHttpGet(url));
  const tarballHttpGet =
    deps.httpGet ??
    ((url: string) =>
      liveHttpGet(url, MAX_REDIRECTS, (received, total) => {
        onProgress?.(received, total);
      }));
  const registryOrigin = deps.registryOrigin ?? DEFAULT_REGISTRY;

  // 1. Resolve tarball URL + integrity from registry.
  const metadataUrl = `${registryOrigin}/${encodeURIComponent(tuple.npmPkg)}/${encodeURIComponent(pinnedVersion)}`;
  let tarballUrl: string;
  let integrity: string;
  try {
    const meta = await httpGet(metadataUrl);
    if (meta.status !== 200) {
      throw new FetcherError(
        "registry",
        `Registry returned HTTP ${meta.status} for ${metadataUrl}`,
      );
    }
    const parsed = JSON.parse(meta.body.toString("utf8")) as {
      dist?: { tarball?: string; integrity?: string };
    };
    if (!parsed.dist?.tarball || !parsed.dist?.integrity) {
      throw new FetcherError(
        "registry",
        `Registry metadata missing dist.tarball or dist.integrity for ${tuple.npmPkg}@${pinnedVersion}`,
      );
    }
    tarballUrl = parsed.dist.tarball;
    integrity = parsed.dist.integrity;
  } catch (err) {
    if (err instanceof FetcherError) throw err;
    throw new FetcherError(
      "network",
      `Failed to fetch registry metadata: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!integrity.startsWith("sha512-")) {
    throw new FetcherError(
      "integrity",
      `Unexpected integrity format (expected sha512-): ${integrity}`,
    );
  }
  const expectedSha512B64 = integrity.slice("sha512-".length);

  // 2. Download tarball.
  onProgress?.(0, null);
  let tarball: Buffer;
  try {
    const dl = await tarballHttpGet(tarballUrl);
    if (dl.status !== 200) {
      throw new FetcherError(
        "network",
        `Tarball download returned HTTP ${dl.status} for ${tarballUrl}`,
      );
    }
    tarball = dl.body;
    onProgress?.(tarball.length, tarball.length);
  } catch (err) {
    if (err instanceof FetcherError) throw err;
    throw new FetcherError(
      "network",
      `Failed to download tarball: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // 3. Verify sha512.
  const actualSha512B64 = crypto.createHash("sha512").update(tarball).digest("base64");
  if (actualSha512B64 !== expectedSha512B64) {
    throw new FetcherError(
      "integrity",
      `sha512 mismatch: expected ${expectedSha512B64}, got ${actualSha512B64}`,
    );
  }

  // 4. Decompress + extract single binary entry.
  let unzipped: Buffer;
  try {
    unzipped = zlib.gunzipSync(tarball);
  } catch (err) {
    throw new FetcherError(
      "extract",
      `Failed to gunzip tarball: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const binaryBuffer = extractBinaryFromTar(unzipped, tuple.binaryName);
  if (!binaryBuffer) {
    throw new FetcherError(
      "extract",
      `Did not find binary entry "${tuple.binaryName}" inside ${tuple.npmPkg}@${pinnedVersion} tarball`,
    );
  }

  // 5. Write to staging path; chmod (POSIX); atomic rename; write marker.
  const rand = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const stagingPath = path.join(pluginDir, `.copilot-binary-extract-${rand}`);
  try {
    fs.writeFileSync(stagingPath, binaryBuffer);
    if (probe.platform !== "win32") {
      fs.chmodSync(stagingPath, 0o755);
    }
    fs.renameSync(stagingPath, finalBinaryPath);
  } catch (err) {
    safeUnlink(stagingPath);
    safeUnlink(finalBinaryPath);
    throw new FetcherError(
      "filesystem",
      `Failed to install binary at ${finalBinaryPath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  try {
    fs.writeFileSync(markerPath, pinnedVersion, "utf8");
  } catch (err) {
    throw new FetcherError(
      "filesystem",
      `Failed to write version marker at ${markerPath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Silence unused warning when os import not otherwise used in some builds
  void path;

  return finalBinaryPath;
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

/**
 * Minimal in-place tar reader. Returns the data buffer of the first entry
 * whose basename matches `targetBasename` (case-sensitive). Supports the
 * ustar format used by npm (which writes regular-file entries via `pax`
 * headers; we skip non-data entry types). Long-name extensions (LongLink,
 * pax_global_header, pax local headers) are tolerated by skipping their
 * data and continuing.
 *
 * Tar format reminder: each entry has a 512-byte header followed by data
 * rounded up to a 512-byte block multiple.
 */
export function extractBinaryFromTar(tarball: Buffer, targetBasename: string): Buffer | null {
  let offset = 0;
  // Pending long name from a LongLink (GNU) or pax header — applies to the
  // next regular file entry, after which it is consumed.
  let pendingName: string | null = null;
  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    // All-zero block = end of archive
    if (header.every((b) => b === 0)) break;
    const name = pendingName ?? readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156]);
    offset += 512;
    const dataLen = isNaN(size) ? 0 : size;
    const padded = Math.ceil(dataLen / 512) * 512;

    // GNU LongLink (L) — next entry's name is in this entry's data
    if (typeflag === "L") {
      const longName = tarball.subarray(offset, offset + dataLen).toString("utf8").replace(/\0+$/, "");
      pendingName = longName;
      offset += padded;
      continue;
    }
    // pax extended header (x or g) — parse 'path=' if present
    if (typeflag === "x" || typeflag === "g") {
      const paxBody = tarball.subarray(offset, offset + dataLen).toString("utf8");
      const m = /^\d+\s+path=(.+)$/m.exec(paxBody);
      if (m && typeflag === "x") pendingName = m[1];
      offset += padded;
      continue;
    }
    // Regular file entries: type "0", "\0", or "7" (contiguous, rare).
    if ((typeflag === "0" || typeflag === "\u0000" || typeflag === "7") && dataLen > 0) {
      const basename = name.split(/[\\/]/).pop() ?? "";
      if (basename === targetBasename) {
        return Buffer.from(tarball.subarray(offset, offset + dataLen));
      }
    }
    pendingName = null;
    offset += padded;
  }
  return null;
}

function readTarString(header: Buffer, off: number, len: number): string {
  const slice = header.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString("utf8");
}
