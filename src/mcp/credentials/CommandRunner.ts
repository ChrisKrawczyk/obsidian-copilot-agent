/**
 * Result of running a credential-producing external command.
 *
 * `timedOut` is set when the runner killed the process for exceeding the
 * supplied `timeoutMs`. In that case `exitCode` is typically `null` (the
 * process did not exit cleanly) and stderr / stdout reflect whatever was
 * captured before the kill.
 */
export interface CommandRunResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit code. When `timedOut` is `true` and the runner killed
   * the process before it exited cleanly, implementations report a
   * sentinel value (Phase 3's `SpawnCommandRunner` uses `-1`) so callers
   * can rely on `number` and route timeout reporting through `timedOut`.
   */
  exitCode: number;
  timedOut: boolean;
}

/**
 * Run an external command and return its captured stdio + exit status.
 *
 * Implementations MUST:
 * - spawn the process directly (`shell: false`) — no shell interpolation
 *   of the user-supplied argv (FR-003)
 * - enforce the supplied `timeoutMs` as a hard cap and kill the process
 *   if exceeded, returning `timedOut: true` (FR-015)
 * - cap stderr capture so a misbehaving command cannot exhaust memory;
 *   the credential resolver further redacts / truncates stderr before
 *   it reaches any error message (FR-010)
 *
 * The implementation lives in `SpawnCommandRunner.ts` (Phase 3). Phase 2
 * uses a fake `CommandRunner` for unit tests of the pure resolver.
 */
export interface CommandRunner {
  run(argv: string[], timeoutMs: number): Promise<CommandRunResult>;
}
