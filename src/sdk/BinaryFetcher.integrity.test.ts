import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import { FileSystemAdapter } from "obsidian";
import {
  MARKER_FILE,
  ensureInstalled,
  type PlatformProbe,
} from "./BinaryFetcher";

/**
 * Dedicated integrity test (Spec FR-025 / planning-docs-review S4):
 * a mutated tarball whose sha512 does not match the registry-published
 * integrity must FAIL and must NOT leave a partial binary at the final
 * path. This is the security gate that prevents a compromised mirror
 * (or in-flight tampering) from landing executable bytes in the vault
 * plugin folder.
 */
describe("BinaryFetcher integrity gate", () => {
  test("tarball mutated post-publish → fails, no binary at final path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-int-"));
    const adapter = new FileSystemAdapter();
    (adapter as unknown as { getBasePath: () => string }).getBasePath = () => dir;
    const plugin = { app: { vault: { adapter } }, manifest: { dir: "." } };
    const probe: PlatformProbe = {
      platform: "win32",
      arch: "x64",
      probeLinuxLibc: () => "glibc",
    };

    const goodTar = buildSingleEntryTar("package/copilot.exe", Buffer.from("expected-bytes"));
    const goodGz = zlib.gzipSync(goodTar);
    const publishedIntegrity = "sha512-" + crypto.createHash("sha512").update(goodGz).digest("base64");

    // Mutate one byte AFTER the integrity was computed — simulates
    // a tampered mirror or transport-layer corruption.
    const mutatedGz = Buffer.from(goodGz);
    mutatedGz[mutatedGz.length - 5] ^= 0xff;

    const httpGet = async (url: string) => {
      if (url === "https://example.com/t.tgz") {
        return { status: 200, headers: {}, body: mutatedGz };
      }
      return {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ dist: { tarball: "https://example.com/t.tgz", integrity: publishedIntegrity } })),
      };
    };

    await expect(
      ensureInstalled(plugin as never, "1.0.0", undefined, { probe, httpGet, registryOrigin: "https://r" }),
    ).rejects.toMatchObject({ kind: "integrity" });

    expect(fs.existsSync(path.join(dir, "copilot.exe"))).toBe(false);
    expect(fs.existsSync(path.join(dir, MARKER_FILE))).toBe(false);
  });
});

function buildSingleEntryTar(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name).copy(header, 0, 0, Math.min(name.length, 100));
  Buffer.from("0000644\0").copy(header, 100);
  Buffer.from("0000000\0").copy(header, 108);
  Buffer.from("0000000\0").copy(header, 116);
  const sizeOctal = data.length.toString(8).padStart(11, "0") + "\0";
  Buffer.from(sizeOctal).copy(header, 124);
  Buffer.from("00000000000\0").copy(header, 136);
  Buffer.from("        ").copy(header, 148);
  header[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  Buffer.from(chk).copy(header, 148);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([
    header,
    data,
    Buffer.alloc(pad, 0),
    Buffer.alloc(1024, 0),
  ]);
}
