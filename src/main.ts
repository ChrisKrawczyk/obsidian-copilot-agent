import { Notice, Plugin } from "obsidian";
import { DEV_TOKEN } from "./dev-token.local";

interface SmokeTestObservations {
  nodeVersion: string;
  electronVersion: string | undefined;
  sdkVersion: string;
  pingOk: boolean;
  helloRoundTripOk: boolean;
  helloResponse?: string;
  customToolPermissionFired: boolean;
  customToolKindReceived?: string;
  builtinPermissionFired: boolean;
  builtinKindReceived?: string;
  errors: string[];
  permissionLog: Array<{ kind: string; toolName?: string; at: number }>;
}

export default class CopilotAgentPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "copilot-agent-smoke-test",
      name: "Copilot Agent: SDK smoke test",
      callback: () => this.runSmokeTest(),
    });
    this.addCommand({
      id: "copilot-agent-spawn-cli-direct",
      name: "Copilot Agent: Spawn CLI directly (diagnostic)",
      callback: () => this.spawnCliDirect(),
    });
  }

  private async spawnCliDirect(): Promise<void> {
    console.group("[copilot-agent] Direct CLI spawn diagnostic");
    try {
      const req = (window as unknown as { require: NodeRequire }).require;
      const cp = req("node:child_process") as typeof import("node:child_process");
      const cliPath =
        "C:\\Repos\\obsidian-copilot-agent\\node_modules\\@github\\copilot-win32-x64\\copilot.exe";
      const args = [
        "--headless",
        "--no-auto-update",
        "--stdio",
        "--auth-token-env",
        "COPILOT_SDK_AUTH_TOKEN",
        "--no-auto-login",
        "--log-level",
        "debug",
      ];
      const env = {
        ...process.env,
        COPILOT_SDK_AUTH_TOKEN: DEV_TOKEN,
      };
      console.log("cliPath:", cliPath);
      console.log("args:", args);
      const child = cp.spawn(cliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
      console.log("spawned PID:", child.pid);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        console.log("[child stdout]", JSON.stringify(s));
      });
      child.stderr!.on("data", (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        console.log("[child stderr]", JSON.stringify(s));
      });
      child.on("error", (e: Error) => console.error("[child error]", e));
      child.on("exit", (code: number | null, signal: string | null) => {
        console.log(
          "[child exit] code=",
          code,
          "signal=",
          signal,
          "stdoutLen=",
          stdout.length,
          "stderrLen=",
          stderr.length,
        );
        new Notice(
          `CLI exit code=${code} signal=${signal}\nstdout=${stdout.length}b stderr=${stderr.length}b`,
          15000,
        );
      });
      // Hold stdin open for 6s, then close
      setTimeout(() => {
        console.log("[diag] 3s tick, child alive?", child.exitCode === null);
      }, 3000);
      setTimeout(() => {
        console.log("[diag] 6s tick, closing stdin");
        try {
          child.stdin!.end();
        } catch (e) {
          console.warn("stdin end failed", e);
        }
      }, 6000);
    } catch (e) {
      console.error("Direct spawn failed", e);
      new Notice(`Direct spawn failed: ${e}`, 10000);
    } finally {
      console.groupEnd();
    }
  }

  private async runSmokeTest(): Promise<void> {
    const obs: SmokeTestObservations = {
      nodeVersion: process.versions.node,
      electronVersion: (process.versions as Record<string, string>).electron,
      sdkVersion: "(unresolved)",
      pingOk: false,
      helloRoundTripOk: false,
      customToolPermissionFired: false,
      builtinPermissionFired: false,
      errors: [],
      permissionLog: [],
    };

    console.group("[copilot-agent] SDK smoke test");
    console.log("Node:", obs.nodeVersion, "Electron:", obs.electronVersion);

    if (!DEV_TOKEN || DEV_TOKEN.startsWith("REPLACE_WITH_")) {
      const msg =
        "DEV_TOKEN is not set. Copy src/dev-token.local.example.ts to " +
        "src/dev-token.local.ts and replace the placeholder.";
      console.error(msg);
      new Notice(msg, 10000);
      console.groupEnd();
      return;
    }

    let sdkModule: typeof import("@github/copilot-sdk");
    try {
      sdkModule = await import("@github/copilot-sdk");
      try {
        // Use require() (synchronous CJS) for node builtins. Dynamic
        // import("node:fs/promises") in an Electron renderer is routed
        // through the browser fetch loader and gets blocked by CORS.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const req = (window as unknown as { require: NodeRequire }).require;
        const fs = req("node:fs") as typeof import("node:fs");
        const path = req("node:path") as typeof import("node:path");
        const sdkPkgPath = path.join(
          "C:\\Repos\\obsidian-copilot-agent\\node_modules\\@github\\copilot-sdk",
          "package.json",
        );
        const raw = fs.readFileSync(sdkPkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) obs.sdkVersion = parsed.version;
      } catch (e) {
        obs.sdkVersion = "(version-not-readable)";
        console.warn("[copilot-agent] SDK version detect failed:", e);
      }
    } catch (err) {
      const e = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      obs.errors.push(`SDK import failed: ${e}`);
      console.error("SDK import failed", err);
      this.report(obs);
      console.groupEnd();
      return;
    }

    const SdkAny = sdkModule as unknown as Record<string, unknown>;
    console.log("SDK exports:", Object.keys(SdkAny));

    const CopilotClient = SdkAny.CopilotClient as
      | (new (opts: Record<string, unknown>) => SmokeClient)
      | undefined;
    const defineTool = SdkAny.defineTool as
      | ((name: string, def: unknown) => unknown)
      | undefined;

    if (!CopilotClient) {
      obs.errors.push("CopilotClient export not found on @github/copilot-sdk");
      this.report(obs);
      console.groupEnd();
      return;
    }

    const onPermissionRequest = (request: PermissionRequest): PermissionDecision => {
      const kind = (request as { kind?: string }).kind ?? "(unknown)";
      const toolName =
        (request as { toolName?: string }).toolName ??
        (request as { tool?: { name?: string } }).tool?.name;
      obs.permissionLog.push({ kind, toolName, at: Date.now() });
      console.log("[onPermissionRequest]", { kind, toolName, request });
      if (kind === "custom-tool" || toolName === "echo") {
        obs.customToolPermissionFired = true;
        obs.customToolKindReceived = kind;
      } else if (kind === "shell" || kind === "write" || kind === "read" || kind === "url") {
        obs.builtinPermissionFired = true;
        obs.builtinKindReceived = kind;
      }
      return { kind: "approve-once" };
    };

    // Path to the standalone Copilot CLI binary. Obsidian.exe has fused
    // out ELECTRON_RUN_AS_NODE, so we cannot use it as a Node interpreter
    // for the .js entry. The npm package @github/copilot ships a
    // platform-specific peer (@github/copilot-win32-x64) containing a SEA
    // (single executable app) that runs without an external Node. SDK
    // detects the .exe extension and spawns it directly.
    // SPIKE-ONLY: hard-coded to dev install. Pre-v0.1, ship the platform
    // binary alongside the plugin and resolve relative to manifest.json.
    const COPILOT_CLI_PATH =
      "C:\\Repos\\obsidian-copilot-agent\\node_modules\\@github\\copilot-win32-x64\\copilot.exe";

    console.log("[copilot-agent] Using CLI path:", COPILOT_CLI_PATH);

    // Capture process.stderr.write so the SDK's `[CLI subprocess]` lines
    // (which it writes via process.stderr.write) reach our console. In an
    // Electron renderer process.stderr.write goes nowhere visible.
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const capturedStderr: string[] = [];
    (process.stderr as unknown as { write: typeof process.stderr.write }).write =
      ((chunk: unknown, ...rest: unknown[]) => {
        try {
          const s = typeof chunk === "string" ? chunk : String(chunk);
          capturedStderr.push(s);
          console.log("[stderr]", s.replace(/\n$/, ""));
        } catch {
          /* ignore */
        }
        return originalStderrWrite(chunk as never, ...(rest as never[]));
      }) as typeof process.stderr.write;

    let client: SmokeClient;
    try {
      client = new CopilotClient({
        gitHubToken: DEV_TOKEN,
        useLoggedInUser: false,
        connection: { kind: "stdio", path: COPILOT_CLI_PATH },
        logLevel: "debug",
      });
      if (typeof client.start === "function") {
        await client.start();
      }
      if (typeof client.ping === "function") {
        await client.ping();
        obs.pingOk = true;
      }
    } catch (err) {
      const e = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      obs.errors.push(`Client init/ping failed: ${e}`);
      // Wait a tick so any pending [stderr] writes from the dying child are
      // captured before we report.
      await new Promise((r) => setTimeout(r, 200));
      const stderrBlob = capturedStderr.join("");
      if (stderrBlob) {
        obs.errors.push(`Captured stderr:\n${stderrBlob}`);
      }
      console.error("Client init/ping failed", err);
      console.error("Captured stderr was:", JSON.stringify(stderrBlob));
      this.report(obs);
      (process.stderr as unknown as { write: typeof process.stderr.write }).write =
        originalStderrWrite;
      console.groupEnd();
      return;
    }

    let session: SmokeSession | undefined;
    try {
      const tools: unknown[] = [];
      if (defineTool) {
        const echoTool = defineTool("echo", {
          description: "Echo back the provided text. Used to verify the permission pipeline.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          handler: async ({ text }: { text: string }) => ({ echoed: text }),
        });
        tools.push(echoTool);
      }

      // Discover available models. The model id we pass to createSession
      // must match one the user's GitHub account is entitled to.
      let pickedModel = "gpt-4.1";
      try {
        const listFn = (client as unknown as { listModels?: () => Promise<unknown[]> }).listModels;
        if (typeof listFn === "function") {
          const models = (await listFn.call(client)) as Array<{
            id?: string;
            name?: string;
            family?: string;
            policy?: { state?: string };
          }>;
          console.log("Available models:", models);
          const enabled = models.filter(
            (m) => !m.policy || m.policy.state === "enabled" || m.policy.state === undefined,
          );
          const pool = enabled.length > 0 ? enabled : models;
          const preferred =
            pool.find((m) => m.id === "gpt-4.1") ??
            pool.find((m) => m.id === "gpt-4o") ??
            pool.find((m) => (m.id ?? "").startsWith("gpt-")) ??
            pool[0];
          if (preferred?.id) pickedModel = preferred.id;
          console.log("[copilot-agent] Selected model:", pickedModel);
        }
      } catch (e) {
        console.warn("listModels failed; falling back to default:", e);
      }

      session = await client.createSession({
        model: pickedModel,
        onPermissionRequest,
        tools,
      });

      const helloResp = await session.sendAndWait(
        "Reply with the single word: hello.",
      );
      obs.helloResponse = extractText(helloResp);
      obs.helloRoundTripOk =
        typeof obs.helloResponse === "string" &&
        obs.helloResponse.toLowerCase().includes("hello");
      console.log("hello round-trip response:", obs.helloResponse);

      const echoResp = await session.sendAndWait(
        "Call the echo tool with text 'hi'. Then tell me what it echoed.",
      );
      console.log("echo round-trip response:", extractText(echoResp));

      const shellResp = await session.sendAndWait(
        "Run the shell command `echo hi` using the shell tool, then tell me what it output.",
      );
      console.log("shell round-trip response:", extractText(shellResp));
    } catch (err) {
      const e = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      obs.errors.push(`Session interaction failed: ${e}`);
      console.error("Session interaction failed", err);
    } finally {
      try {
        if (session && typeof session.dispose === "function") {
          await session.dispose();
        } else if (session && typeof session.abort === "function") {
          session.abort();
        }
        if (typeof client.dispose === "function") {
          await client.dispose();
        }
      } catch (err) {
        console.warn("Cleanup error", err);
      }
    }

    (process.stderr as unknown as { write: typeof process.stderr.write }).write =
      originalStderrWrite;
    this.report(obs);
    console.log("Permission log:", obs.permissionLog);
    console.log("Captured stderr buffer length:", capturedStderr.join("").length);
    console.groupEnd();
  }

  private report(obs: SmokeTestObservations): void {
    const lines = [
      `Copilot Agent smoke test`,
      `Node ${obs.nodeVersion} / Electron ${obs.electronVersion ?? "?"} / SDK ${obs.sdkVersion}`,
      `ping: ${obs.pingOk ? "OK" : "FAIL"}`,
      `hello round-trip: ${obs.helloRoundTripOk ? "OK" : "FAIL"}${
        obs.helloResponse ? ` (${truncate(obs.helloResponse, 80)})` : ""
      }`,
      `custom-tool permission fired: ${obs.customToolPermissionFired ? "YES" : "NO"}${
        obs.customToolKindReceived ? ` (kind=${obs.customToolKindReceived})` : ""
      }`,
      `built-in permission fired: ${obs.builtinPermissionFired ? "YES" : "NO"}${
        obs.builtinKindReceived ? ` (kind=${obs.builtinKindReceived})` : ""
      }`,
    ];
    if (obs.errors.length) {
      lines.push("", "Errors:");
      for (const e of obs.errors) lines.push(`- ${truncate(e, 200)}`);
    }
    new Notice(lines.join("\n"), 20000);
    console.log(obs);
  }
}

function extractText(resp: unknown): string | undefined {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    const data = r.data as Record<string, unknown> | undefined;
    if (data && typeof data.content === "string") return data.content;
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    if (typeof r.message === "string") return r.message;
    const msg = r.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

interface PermissionRequest {
  kind?: string;
  toolName?: string;
}
interface PermissionDecision {
  kind:
    | "approve-once"
    | "approve-for-session"
    | "approve-for-location"
    | "approve-permanently"
    | "reject"
    | "user-not-available"
    | "no-result";
}
interface SmokeSession {
  sendAndWait: (prompt: string) => Promise<unknown>;
  abort?: () => void;
  dispose?: () => Promise<void> | void;
}
interface SmokeClient {
  start?: () => Promise<void> | void;
  ping?: () => Promise<unknown> | unknown;
  createSession: (opts: Record<string, unknown>) => Promise<SmokeSession>;
  dispose?: () => Promise<void> | void;
}
