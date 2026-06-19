import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock the BinaryFetcher seam BEFORE main.ts is loaded so the
// CopilotAgentPlugin.ensureCliBinaryReady method we exercise here uses
// the stubs rather than touching real npm registries or filesystem.
vi.mock("../src/sdk/BinaryFetcher", async () => {
  const actual = await vi.importActual<typeof import("../src/sdk/BinaryFetcher")>(
    "../src/sdk/BinaryFetcher",
  );
  return {
    ...actual,
    isInstalled: vi.fn(() => false),
    ensureInstalled: vi.fn(async () => "C:/fake/plugin/copilot.exe"),
    getRequiredBinaryPath: vi.fn(() => "C:/fake/plugin/copilot.exe"),
  };
});

import CopilotAgentPlugin from "../src/main";
import { FetcherError, ensureInstalled, isInstalled } from "../src/sdk/BinaryFetcher";

function makePluginInstance(): CopilotAgentPlugin {
  // CopilotAgentPlugin extends Obsidian's mocked Plugin — its constructor
  // signature in real Obsidian is `(app, manifest)`. The mock accepts
  // zero args; the fields we touch (binaryFetchError, pinnedBinaryVersion,
  // ensureCliBinaryReady) are all set in the class body, not derived
  // from the constructor inputs.
  const p = Object.create(CopilotAgentPlugin.prototype) as CopilotAgentPlugin;
  // Initialise the binaryFetchError field manually since we bypassed the constructor.
  (p as unknown as { binaryFetchError: FetcherError | null }).binaryFetchError = null;
  (p as unknown as { pinnedBinaryVersion: string }).pinnedBinaryVersion = "1.0.0";
  return p;
}

describe("CopilotAgentPlugin.ensureCliBinaryReady", () => {
  beforeEach(() => {
    vi.mocked(isInstalled).mockReset();
    vi.mocked(ensureInstalled).mockReset();
  });

  test("fast path: already installed → returns path without fetching", async () => {
    vi.mocked(isInstalled).mockReturnValueOnce(true);
    const p = makePluginInstance();
    const result = await p.ensureCliBinaryReady();
    expect(result).toBe("C:/fake/plugin/copilot.exe");
    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(p.binaryFetchError).toBeNull();
  });

  test("happy fetch path: returns the new binary path and clears error", async () => {
    vi.mocked(isInstalled).mockReturnValueOnce(false);
    vi.mocked(ensureInstalled).mockResolvedValueOnce("C:/fake/plugin/copilot.exe");
    const p = makePluginInstance();
    p.binaryFetchError = new FetcherError("network", "previous failure");
    const result = await p.ensureCliBinaryReady();
    expect(result).toBe("C:/fake/plugin/copilot.exe");
    expect(p.binaryFetchError).toBeNull();
    expect(ensureInstalled).toHaveBeenCalledTimes(1);
  });

  test("FetcherError path: stores error and returns null", async () => {
    vi.mocked(isInstalled).mockReturnValueOnce(false);
    vi.mocked(ensureInstalled).mockRejectedValueOnce(new FetcherError("network", "ECONNREFUSED"));
    const p = makePluginInstance();
    const result = await p.ensureCliBinaryReady();
    expect(result).toBeNull();
    expect(p.binaryFetchError).toBeInstanceOf(FetcherError);
    expect(p.binaryFetchError?.kind).toBe("network");
  });

  test("unsupported-platform from isInstalled probe → returns null with stored error, no fetch", async () => {
    vi.mocked(isInstalled).mockImplementationOnce(() => {
      throw new FetcherError("unsupported-platform", "freebsd not supported");
    });
    const p = makePluginInstance();
    const result = await p.ensureCliBinaryReady();
    expect(result).toBeNull();
    expect(p.binaryFetchError?.kind).toBe("unsupported-platform");
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  test("non-FetcherError thrown from ensureInstalled is wrapped as filesystem", async () => {
    vi.mocked(isInstalled).mockReturnValueOnce(false);
    vi.mocked(ensureInstalled).mockRejectedValueOnce(new Error("EACCES open /path"));
    const p = makePluginInstance();
    const result = await p.ensureCliBinaryReady();
    expect(result).toBeNull();
    expect(p.binaryFetchError?.kind).toBe("filesystem");
  });
});
