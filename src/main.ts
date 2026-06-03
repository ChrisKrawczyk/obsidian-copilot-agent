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
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const url = await import("node:url");
        const sdkEntry = url.fileURLToPath(
          new URL("@github/copilot-sdk", import.meta.url),
        );
        const sdkPkgPath = path.join(path.dirname(sdkEntry), "..", "package.json");
        const raw = await fs.readFile(sdkPkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) obs.sdkVersion = parsed.version;
      } catch {
        obs.sdkVersion = "(version-not-readable)";
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

    let client: SmokeClient;
    try {
      client = new CopilotClient({
        gitHubToken: DEV_TOKEN,
        useLoggedInUser: false,
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
      console.error("Client init/ping failed", err);
      this.report(obs);
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

      session = await client.createSession({
        model: "gpt-4o-mini",
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

    this.report(obs);
    console.log("Permission log:", obs.permissionLog);
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
