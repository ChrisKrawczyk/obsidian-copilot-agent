import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import path from "node:path";
import { buildStdioEnv } from "../stdioEnv";
import { findOnPath } from "../transport/findOnPath";
import type { CommandRunResult, CommandRunner } from "./CommandRunner";

/** Sentinel exitCode reported when the runner killed the process for timeout. */
export const TIMEOUT_EXIT_CODE = -1;

/** Hard cap on captured stderr bytes — keeps a runaway command from exhausting memory. */
export const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;
/** Hard cap on captured stdout bytes — credential JSON should be tiny. */
export const STDOUT_CAPTURE_LIMIT_BYTES = 256 * 1024;

/** Grace period before SIGKILL after the initial timeout SIGTERM. */
const SIGKILL_GRACE_MS = 500;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface SpawnCommandRunnerOptions {
  /** Override `process.platform` for unit tests. */
  platform?: NodeJS.Platform;
  /** Override `process.env` for unit tests. */
  inheritedEnv?: NodeJS.ProcessEnv;
  /** Override `child_process.spawn` for unit tests. */
  spawn?: SpawnFn;
  /** Override `setTimeout` / `clearTimeout` for unit tests. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/**
 * Spawn-based `CommandRunner` implementation. Used by `CredentialResolver`
 * (Phase 2) when invoking credential-producing helpers like
 * `az account get-access-token`.
 *
 * Contract:
 * - `shell: false` always — the user-supplied argv MUST NOT be interpreted
 *   by any shell (FR-003).
 * - On Windows, `.cmd` / `.bat` targets are executed via `cmd.exe /d /s /c`
 *   with the resolved batch path and trailing argv passed as a SINGLE argv
 *   array (not a joined string), so Node's Windows-argv quoting protects
 *   each user argument from cmd.exe metacharacter interpretation. Mirrors
 *   the existing `StdioTransport.resolveCommandForSpawn` pattern.
 * - Environment is filtered through `buildStdioEnv` — credential-related
 *   tokens already in the inherited environment are stripped before
 *   handing the env to the child process.
 * - Hard timeout enforced via `setTimeout` + `kill('SIGTERM')`, escalated
 *   to `SIGKILL` after a 500ms grace if the child has not exited.
 * - stdout / stderr captured into bounded buffers; over-cap bytes are
 *   silently dropped (the resolver further trims and redacts before any
 *   error surfaces).
 */
export class SpawnCommandRunner implements CommandRunner {
  private readonly platform: NodeJS.Platform;
  private readonly inheritedEnv: NodeJS.ProcessEnv;
  private readonly spawn: SpawnFn;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(options: SpawnCommandRunnerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.inheritedEnv = options.inheritedEnv ?? process.env;
    this.spawn = options.spawn ?? (nodeSpawn as SpawnFn);
    // Wrap timer functions to preserve their global `this` binding. In
    // Obsidian's Electron renderer process, the global `setTimeout` /
    // `clearTimeout` are browser methods that require `this === window`;
    // calling them via `this.setTimeoutFn(...)` would bind `this` to the
    // class instance and throw "Illegal invocation". Tests pass their own
    // function — wrap it the same way so behavior is identical.
    const rawSetTimeout = options.setTimeout ?? setTimeout;
    const rawClearTimeout = options.clearTimeout ?? clearTimeout;
    this.setTimeoutFn = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
      rawSetTimeout(fn, ms, ...rest)) as typeof setTimeout;
    this.clearTimeoutFn = ((handle: ReturnType<typeof setTimeout>) =>
      rawClearTimeout(handle)) as typeof clearTimeout;
  }

  run(argv: string[], timeoutMs: number): Promise<CommandRunResult> {
    if (argv.length === 0) {
      return Promise.resolve({
        stdout: "",
        stderr: "Credential command is empty.",
        exitCode: TIMEOUT_EXIT_CODE,
        timedOut: false,
      });
    }

    const envResult = buildStdioEnv({
      inheritedEnv: this.inheritedEnv,
      platform: this.platform,
    });
    const env = envResult.env;
    const resolved = resolveCommandForSpawn(argv[0], argv.slice(1), env, this.platform);

    return new Promise<CommandRunResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawn(resolved.command, resolved.args, {
          env,
          shell: false,
          stdio: "pipe",
          windowsHide: true,
          // For the cmd.exe /d /s /c wrapper path, we have already wrapped
          // each user-controlled argv element in double quotes (see
          // `resolveCommandForSpawn`). Disabling Node's own quoting layer
          // ensures those quotes reach cmd.exe verbatim and metacharacters
          // like `&`, `|`, `<`, `>`, `(`, `)`, `^` inside the quoted args
          // are NOT interpreted as cmd command separators / redirectors.
          windowsVerbatimArguments: resolved.usedCmdWrapper,
        });
      } catch (err) {
        resolve({
          stdout: "",
          stderr: (err as Error)?.message ?? "spawn failed",
          exitCode: TIMEOUT_EXIT_CODE,
          timedOut: false,
        });
        return;
      }

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timer = this.setTimeoutFn(() => {
        timedOut = true;
        try {
          child.kill(this.platform === "win32" ? undefined : "SIGTERM");
        } catch {
          // best effort
        }
        killTimer = this.setTimeoutFn(() => {
          try {
            child.kill(this.platform === "win32" ? undefined : "SIGKILL");
          } catch {
            // best effort
          }
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= STDOUT_CAPTURE_LIMIT_BYTES) return;
        const remaining = STDOUT_CAPTURE_LIMIT_BYTES - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= STDERR_CAPTURE_LIMIT_BYTES) return;
        const remaining = STDERR_CAPTURE_LIMIT_BYTES - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      });

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        if (killTimer) this.clearTimeoutFn(killTimer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
          timedOut,
        });
      };

      child.on("error", (err) => {
        if (settled) return;
        stderrChunks.push(Buffer.from(`${err.message}\n`, "utf8"));
        finish(TIMEOUT_EXIT_CODE);
      });
      child.on("close", (code) => {
        finish(typeof code === "number" ? code : TIMEOUT_EXIT_CODE);
      });
    });
  }
}

/**
 * Compute the actual `(command, args)` to pass to `child_process.spawn`
 * for a user-supplied argv.
 *
 * On Windows, `.cmd` / `.bat` targets are wrapped in `cmd.exe /d /s /c ...`
 * using the same approach as the widely-used `cross-spawn` library:
 *
 *   1. Each argv element (the resolved script path AND each user argument)
 *      is wrapped in `"..."`, with internal `"` escaped as `\"` (and any
 *      backslash run before a quote doubled, per CommandLineToArgvW rules).
 *   2. The complete joined command line is wrapped in ONE additional outer
 *      `"..."` pair, which is consumed by cmd's `/s /c` quote-strip rule.
 *      The per-token inner quotes survive intact, so when cmd's parser
 *      then tokenizes the remainder, every metacharacter (`& | < > ( )
 *      ^`) inside a user-supplied token is inside a double-quoted region
 *      and is NOT interpreted as a separator / redirector / variable.
 *
 * Caller MUST set `windowsVerbatimArguments: true` so Node passes these
 * strings verbatim to CreateProcess instead of re-quoting on top.
 *
 * NOTE on script-author responsibility: this scheme guarantees that argv
 * elements reach the invoked `.cmd` / `.bat` process with metacharacters
 * intact. If the batch script itself substitutes its arguments via `%~1`
 * / `%*` into another command line, that script is responsible for
 * quoting the substitution (`echo "%~1"`) or using delayed expansion.
 * The shipped M365 preset uses `az.cmd`, whose well-written launcher
 * passes argv directly to the Python interpreter via the Windows argv
 * array and is unaffected.
 */
export function resolveCommandForSpawn(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  platform: NodeJS.Platform,
): { command: string; args: string[]; usedCmdWrapper: boolean } {
  // Windows-only: bare command without an extension (e.g. `az`) cannot be
  // executed via `spawn(..., { shell: false })` because Node passes the
  // exact filename to CreateProcess and only that filename is probed on
  // PATH. Resolve through PATHEXT so `az` → `az.cmd`, then fall through to
  // the existing `.cmd` / `.bat` wrapper branch below.
  let resolvedCommand = command;
  if (platform === "win32" && !path.extname(command)) {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
    for (const ext of pathext) {
      const candidate = command + ext.toLowerCase();
      const found = findOnPath(candidate, env);
      if (found) {
        resolvedCommand = found;
        break;
      }
    }
  }
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand, args: [...args], usedCmdWrapper: false };
  }
  const resolved = path.isAbsolute(resolvedCommand)
    ? resolvedCommand
    : findOnPath(resolvedCommand, env) ?? resolvedCommand;
  const tokens = [resolved, ...args].map(quoteForCmd);
  const inner = tokens.join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `"${inner}"`],
    usedCmdWrapper: true,
  };
}

/**
 * Wrap a single argv element in `"..."` for safe Windows argv passthrough.
 *
 * Two layers of escaping:
 *  - Internal `"` escaped as `\"`; runs of `\` preceding a quote (or the
 *    closing wrap) are doubled per CommandLineToArgvW rules so the value
 *    survives Node→CreateProcess→child argv parsing.
 *  - Each `%` is rewritten as `"^%"` — closing the surrounding quote,
 *    emitting `^%` (cmd's "literal `%`" escape, which only works OUTSIDE
 *    quotes), then reopening the quote. cmd's tokenizer concatenates
 *    adjacent quoted segments into one argv element, so the original
 *    string content is preserved while environment-variable expansion
 *    (`%USERNAME%`, `%COMSPEC%`, etc.) is suppressed. This closes the
 *    FR-003 "no shell interpolation of user-supplied argv" gap that
 *    plain quoting leaves open.
 */
function quoteForCmd(arg: string): string {
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")
    .replace(/%/g, '"^%"');
  return `"${escaped}"`;
}
