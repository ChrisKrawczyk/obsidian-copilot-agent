import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import { FileSystemAdapter } from "obsidian";
import {
  FetcherError,
  MARKER_FILE,
  detectPlatformTuple,
  ensureInstalled,
  extractBinaryFromTar,
  getMarkerPath,
  getRequiredBinaryPath,
  isInstalled,
  type PlatformProbe,
} from "./BinaryFetcher";

function probeFor(platform: NodeJS.Platform, arch: string, libc: "glibc" | "musl" | "unknown" = "glibc"): PlatformProbe {
  return { platform, arch, probeLinuxLibc: () => libc };
}

interface FakePlugin {
  app: { vault: { adapter: FileSystemAdapter } };
  manifest: { dir: string };
}

function makeFakePluginDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-bf-"));
}

function makeFakePlugin(absDir: string, manifestDirOverride?: string): FakePlugin {
  const adapter = new FileSystemAdapter();
  (adapter as unknown as { getBasePath: () => string }).getBasePath = () => absDir;
  return {
    app: { vault: { adapter } },
    manifest: { dir: manifestDirOverride ?? "." },
  };
}

describe("detectPlatformTuple", () => {
  test("win32 x64", () => {
    const t = detectPlatformTuple(probeFor("win32", "x64"));
    expect(t).toEqual({ os: "win32", arch: "x64", binaryName: "copilot.exe", npmPkg: "@github/copilot-win32-x64" });
  });
  test("win32 arm64", () => {
    expect(detectPlatformTuple(probeFor("win32", "arm64")).npmPkg).toBe("@github/copilot-win32-arm64");
  });
  test("darwin x64", () => {
    const t = detectPlatformTuple(probeFor("darwin", "x64"));
    expect(t).toMatchObject({ os: "darwin", binaryName: "copilot", npmPkg: "@github/copilot-darwin-x64" });
  });
  test("darwin arm64", () => {
    expect(detectPlatformTuple(probeFor("darwin", "arm64")).npmPkg).toBe("@github/copilot-darwin-arm64");
  });
  test("linux glibc x64", () => {
    expect(detectPlatformTuple(probeFor("linux", "x64", "glibc"))).toMatchObject({ os: "linux", npmPkg: "@github/copilot-linux-x64" });
  });
  test("linux glibc arm64", () => {
    expect(detectPlatformTuple(probeFor("linux", "arm64", "glibc")).npmPkg).toBe("@github/copilot-linux-arm64");
  });
  test("linux musl x64", () => {
    expect(detectPlatformTuple(probeFor("linux", "x64", "musl")).npmPkg).toBe("@github/copilot-linuxmusl-x64");
  });
  test("linux musl arm64", () => {
    expect(detectPlatformTuple(probeFor("linux", "arm64", "musl")).npmPkg).toBe("@github/copilot-linuxmusl-arm64");
  });
  test("linux unknown libc → unsupported-platform", () => {
    expect(() => detectPlatformTuple(probeFor("linux", "x64", "unknown"))).toThrow(FetcherError);
    try {
      detectPlatformTuple(probeFor("linux", "x64", "unknown"));
    } catch (e) {
      expect((e as FetcherError).kind).toBe("unsupported-platform");
    }
  });
  test("unsupported arch → unsupported-platform", () => {
    try {
      detectPlatformTuple(probeFor("linux", "ia32", "glibc"));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as FetcherError).kind).toBe("unsupported-platform");
    }
  });
  test("unsupported OS → unsupported-platform", () => {
    try {
      detectPlatformTuple(probeFor("freebsd" as NodeJS.Platform, "x64"));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as FetcherError).kind).toBe("unsupported-platform");
    }
  });
});

describe("extractBinaryFromTar", () => {
  test("finds a regular file entry by basename", () => {
    const tar = buildMinimalTar([
      { name: "package/README.md", data: Buffer.from("hi") },
      { name: "package/copilot.exe", data: Buffer.from("FAKE-BINARY-BYTES") },
    ]);
    const out = extractBinaryFromTar(tar, "copilot.exe");
    expect(out).not.toBeNull();
    expect(out!.toString("utf8")).toBe("FAKE-BINARY-BYTES");
  });
  test("returns null when target absent", () => {
    const tar = buildMinimalTar([{ name: "package/README.md", data: Buffer.from("hi") }]);
    expect(extractBinaryFromTar(tar, "copilot")).toBeNull();
  });
});

describe("isInstalled and getRequiredBinaryPath", () => {
  test("missing binary → false", () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    expect(isInstalled(plugin, "1.0.59", probeFor("win32", "x64"))).toBe(false);
  });
  test("binary + matching marker → true", () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const tuple = detectPlatformTuple(probeFor("win32", "x64"));
    fs.writeFileSync(path.join(tmp, tuple.binaryName), "x");
    fs.writeFileSync(path.join(tmp, MARKER_FILE), "1.0.59");
    expect(isInstalled(plugin, "1.0.59", probeFor("win32", "x64"))).toBe(true);
  });
  test("binary present but marker missing → false (no fallback)", () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const tuple = detectPlatformTuple(probeFor("win32", "x64"));
    fs.writeFileSync(path.join(tmp, tuple.binaryName), "x");
    expect(isInstalled(plugin, "1.0.59", probeFor("win32", "x64"))).toBe(false);
  });
  test("binary + mismatched marker → false", () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const tuple = detectPlatformTuple(probeFor("win32", "x64"));
    fs.writeFileSync(path.join(tmp, tuple.binaryName), "x");
    fs.writeFileSync(path.join(tmp, MARKER_FILE), "1.0.0");
    expect(isInstalled(plugin, "1.0.59", probeFor("win32", "x64"))).toBe(false);
  });
  test("getRequiredBinaryPath joins plugin dir + binary name", () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const p = getRequiredBinaryPath(plugin, probeFor("linux", "x64", "glibc"));
    expect(p).toBe(path.join(tmp, "copilot"));
    expect(getMarkerPath(plugin)).toBe(path.join(tmp, MARKER_FILE));
  });
});

describe("ensureInstalled (with injected http + probe)", () => {
  test("happy path: downloads, verifies, extracts, marks", async () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const probe = probeFor("win32", "x64");
    const binaryBody = Buffer.from("real-binary-bytes");
    const tar = buildMinimalTar([{ name: "package/copilot.exe", data: binaryBody }]);
    const gz = zlib.gzipSync(tar);
    const integrity = "sha512-" + crypto.createHash("sha512").update(gz).digest("base64");
    const tarballUrl = "https://example.com/tarball.tgz";
    const httpGet = async (url: string) => {
      if (url.includes("registry") || url.includes("encoded")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ dist: { tarball: tarballUrl, integrity } })),
        };
      }
      if (url === tarballUrl) {
        return { status: 200, headers: {}, body: gz };
      }
      throw new Error("unexpected url " + url);
    };
    const progress: number[] = [];
    const result = await ensureInstalled(plugin, "1.2.3", (b) => progress.push(b), {
      probe,
      httpGet,
      registryOrigin: "https://registry.example.com",
    });
    expect(result).toBe(path.join(tmp, "copilot.exe"));
    expect(fs.readFileSync(result).toString("utf8")).toBe("real-binary-bytes");
    expect(fs.readFileSync(path.join(tmp, MARKER_FILE), "utf8")).toBe("1.2.3");
    expect(progress.length).toBeGreaterThan(0);
  });

  test("integrity mismatch → FetcherError(integrity) and no binary written", async () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const probe = probeFor("linux", "x64", "glibc");
    const tar = buildMinimalTar([{ name: "package/copilot", data: Buffer.from("payload") }]);
    const gz = zlib.gzipSync(tar);
    const wrongIntegrity = "sha512-" + Buffer.from("wronghashwronghashwronghashwronghashwronghashwronghashwronghashwronghashwronghashwronghashw").toString("base64");
    const httpGet = async (url: string) => {
      if (url.includes("registry")) {
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ dist: { tarball: "https://example.com/t.tgz", integrity: wrongIntegrity } })) };
      }
      return { status: 200, headers: {}, body: gz };
    };
    await expect(
      ensureInstalled(plugin, "1.0.0", undefined, { probe, httpGet, registryOrigin: "https://registry.example.com" }),
    ).rejects.toMatchObject({ kind: "integrity" });
    expect(fs.existsSync(path.join(tmp, "copilot"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, MARKER_FILE))).toBe(false);
  });

  test("registry HTTP 404 → FetcherError(registry)", async () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const httpGet = async () => ({ status: 404, headers: {}, body: Buffer.from("not found") });
    await expect(
      ensureInstalled(plugin, "9.9.9", undefined, { probe: probeFor("win32", "x64"), httpGet, registryOrigin: "https://r" }),
    ).rejects.toMatchObject({ kind: "registry" });
  });

  test("network error → FetcherError(network)", async () => {
    const tmp = makeFakePluginDir();
    const plugin = makeFakePlugin(tmp);
    const httpGet = async () => { throw new Error("ECONNREFUSED"); };
    await expect(
      ensureInstalled(plugin, "1.0.0", undefined, { probe: probeFor("win32", "x64"), httpGet, registryOrigin: "https://r" }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  test("filesystem write error → FetcherError(filesystem), no partial", async () => {
    const tmp = makeFakePluginDir();
    // Point manifest.dir to a deeply-nested missing path so writeFileSync fails.
    const plugin = makeFakePlugin(tmp, "plugin/does/not/exist");
    const probe = probeFor("win32", "x64");
    const tar = buildMinimalTar([{ name: "package/copilot.exe", data: Buffer.from("x") }]);
    const gz = zlib.gzipSync(tar);
    const integrity = "sha512-" + crypto.createHash("sha512").update(gz).digest("base64");
    const httpGet = async (url: string) => {
      if (url === "https://example.com/t.tgz") {
        return { status: 200, headers: {}, body: gz };
      }
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ dist: { tarball: "https://example.com/t.tgz", integrity } })) };
    };
    await expect(
      ensureInstalled(plugin as never, "1.0.0", undefined, { probe, httpGet, registryOrigin: "https://r" }),
    ).rejects.toMatchObject({ kind: "filesystem" });
  });
});

// --- helpers for the file-system tests ---
// (definitions moved above)

function buildMinimalTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(e.name).copy(header, 0, 0, Math.min(e.name.length, 100));
    // mode (8 bytes octal + null), uid/gid (8), size (12), mtime (12)
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    const sizeOctal = e.data.length.toString(8).padStart(11, "0") + "\0";
    Buffer.from(sizeOctal).copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    // chksum field starts at 148, 8 bytes: fill with spaces for checksum calc
    Buffer.from("        ").copy(header, 148);
    // typeflag = '0' regular file
    header[156] = "0".charCodeAt(0);
    // ustar magic
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    // checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    const chk = sum.toString(8).padStart(6, "0") + "\0 ";
    Buffer.from(chk).copy(header, 148);
    chunks.push(header);
    chunks.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  // two zero blocks
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}
