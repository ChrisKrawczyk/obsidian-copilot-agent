import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildStdioEnv } from "../stdioEnv";
import { redactSensitive } from "../redactSensitive";

export const MCP_STDIO_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
export const MCP_STDERR_RING_LIMIT_BYTES = 64 * 1024;
export const MCP_STDERR_TRUNCATED_MARKER = "[stderr truncated; showing last 64 KiB]\n";

export interface StdioTransportConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface StdioTransportOptions {
  vaultRoot: string;
  platform?: NodeJS.Platform;
  inheritedEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export class StdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = "";
  private stderrTruncated = false;
  private closed = false;

  constructor(
    private readonly config: StdioTransportConfig,
    private readonly options: StdioTransportOptions,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const spawn = this.options.spawn ?? nodeSpawn;
    const platform = this.options.platform ?? process.platform;
    const envResult = buildStdioEnv({
      inheritedEnv: this.options.inheritedEnv,
      explicitEnv: this.config.env,
      platform,
    });
    const command = resolveCommandForSpawn(
      this.config.command,
      envResult.env,
      platform,
      this.config.args,
    );
    this.child = spawn(command.command, command.args, {
      cwd: this.config.cwd ?? this.options.vaultRoot,
      env: envResult.env,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.captureStderr(chunk));
    this.child.on("error", (error) => this.onerror?.(sanitizeError(error)));
    this.child.on("close", () => this.finishClose());
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("MCP stdio transport is not running.");
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MCP_STDIO_FRAME_LIMIT_BYTES) {
      throw new Error("MCP stdio frame exceeds 16 MiB.");
    }
    await new Promise<void>((resolve, reject) => {
      this.child?.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.finishClose();
      return;
    }
    child.stdin.end();
    this.finishClose();
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MCP_STDIO_FRAME_LIMIT_BYTES) {
      this.onerror?.(new Error("MCP stdio frame exceeds 16 MiB."));
      void this.close();
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (err) {
        this.onerror?.(sanitizeError(err));
      }
    }
  }

  private captureStderr(chunk: Buffer): void {
    const clean = redactSensitive(escapeControls(chunk.toString("utf8")));
    this.stderrTail += clean;
    if (Buffer.byteLength(this.stderrTail, "utf8") > MCP_STDERR_RING_LIMIT_BYTES) {
      this.stderrTruncated = true;
      const bytes = Buffer.from(this.stderrTail, "utf8");
      this.stderrTail = Buffer.from(
        bytes.slice(Math.max(0, bytes.length - MCP_STDERR_RING_LIMIT_BYTES)),
      ).toString("utf8");
    }
    if (this.stderrTruncated && !this.stderrTail.startsWith(MCP_STDERR_TRUNCATED_MARKER)) {
      this.stderrTail = `${MCP_STDERR_TRUNCATED_MARKER}${this.stderrTail}`;
    }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

export function resolveCommandForSpawn(
  command: string,
  env: Record<string, string>,
  platform: NodeJS.Platform,
  args: readonly string[],
): { command: string; args: string[] } {
  if (platform !== "win32" || !/\.cmd$/i.test(command)) {
    return { command, args: [...args] };
  }
  const resolved = path.isAbsolute(command) ? command : findOnPath(command, env) ?? command;
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", resolved, ...args],
  };
}

function findOnPath(command: string, env: Record<string, string>): string | null {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const pathValue = pathKey ? env[pathKey] : "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    return path.join(entry, command);
  }
  return null;
}

function sanitizeError(err: unknown): Error {
  const source = err instanceof Error ? err : new Error(String(err));
  const next = new Error(redactSensitive(source.message));
  next.stack = source.stack ? redactSensitive(source.stack) : undefined;
  return next;
}

function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
