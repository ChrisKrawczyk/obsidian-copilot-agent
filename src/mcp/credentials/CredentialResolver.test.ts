import { describe, it, expect, beforeEach } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  CredentialResolutionFailed,
  CredentialResolver,
  MAX_STDERR_SNIPPET_LENGTH,
  MIN_RERESOLVE_INTERVAL_MS,
} from "./CredentialResolver";
import type {
  CommandRunResult,
  CommandRunner,
} from "./CommandRunner";
import type { ServerCredentials } from "./CredentialTypes";

class FakeClock {
  constructor(public now = 1_700_000_000_000) {}
  read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

interface RecordedRun {
  argv: string[];
  timeoutMs: number;
}

class FakeRunner implements CommandRunner {
  readonly calls: RecordedRun[] = [];
  responses: CommandRunResult[] = [];

  enqueue(result: CommandRunResult): void {
    this.responses.push(result);
  }

  async run(argv: string[], timeoutMs: number): Promise<CommandRunResult> {
    this.calls.push({ argv, timeoutMs });
    if (this.responses.length === 0) {
      throw new Error(
        "FakeRunner: no queued response (test forgot to enqueue?)",
      );
    }
    return this.responses.shift()!;
  }
}

class CapturingLogger {
  readonly messages: string[] = [];
  warn(message: string): void {
    this.messages.push(message);
  }
}

function ok(stdout: string, stderr = ""): CommandRunResult {
  return { stdout, stderr, exitCode: 0, timedOut: false };
}

function fail(
  exitCode: number,
  stderr = "",
  stdout = "",
): CommandRunResult {
  return { stdout, stderr, exitCode, timedOut: false };
}

function buildResolver() {
  const clock = new FakeClock();
  const runner = new FakeRunner();
  const logger = new CapturingLogger();
  const resolver = new CredentialResolver({
    clock: clock.read,
    runner,
    logger,
  });
  return { clock, runner, logger, resolver };
}

const FUTURE_ISO = "2099-01-15T18:30:00Z";

describe("CredentialResolver", () => {
  describe("kind=none", () => {
    it("returns null without invoking runner", async () => {
      const { runner, resolver } = buildResolver();
      const result = await resolver.resolve("srv", { kind: "none" });
      expect(result).toBeNull();
      expect(runner.calls).toHaveLength(0);
    });
  });

  describe("kind=static-bearer", () => {
    it("passes through token with Bearer prefix added", async () => {
      const { runner, resolver } = buildResolver();
      const result = await resolver.resolve("srv", {
        kind: "static-bearer",
        token: "abc",
      });
      expect(result).toEqual({
        authorization: "Bearer abc",
        expiresAt: null,
        tenantId: null,
      });
      expect(runner.calls).toHaveLength(0);
    });

    it("does not double-prefix when token already starts with Bearer", async () => {
      const { resolver } = buildResolver();
      const result = await resolver.resolve("srv", {
        kind: "static-bearer",
        token: "Bearer already",
      });
      expect(result?.authorization).toBe("Bearer already");
    });
  });

  describe("kind=oauth-pkce", () => {
    it("throws not-implemented error", async () => {
      const { resolver } = buildResolver();
      await expect(
        resolver.resolve("srv", {
          kind: "oauth-pkce",
          authorizationEndpoint: "https://example.com/auth",
          tokenEndpoint: "https://example.com/token",
          clientId: "id",
          scopes: ["a"],
        }),
      ).rejects.toMatchObject({
        error: { kind: "not-implemented", variant: "oauth-pkce" },
      });
    });
  });

  describe("kind=command-based — happy path", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "az account get-access-token",
    };

    it("invokes runner with parsed argv and timeout", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ accessToken: "t1", expiresOn: FUTURE_ISO })));
      const result = await resolver.resolve("srv", creds);
      expect(result?.authorization).toBe("Bearer t1");
      expect(result?.expiresAt).toBe(Date.parse(FUTURE_ISO));
      expect(runner.calls[0].argv).toEqual([
        "az",
        "account",
        "get-access-token",
      ]);
      expect(runner.calls[0].timeoutMs).toBe(COMMAND_TIMEOUT_MS);
    });

    it("uses explicit args array verbatim when supplied", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ accessToken: "t1", expiresOn: FUTURE_ISO })));
      await resolver.resolve("srv", {
        kind: "command-based",
        command: "az",
        args: ["account", "get-access-token", "--resource", "https://graph.microsoft.com"],
      });
      expect(runner.calls[0].argv).toEqual([
        "az",
        "account",
        "get-access-token",
        "--resource",
        "https://graph.microsoft.com",
      ]);
    });

    it("honors empty args array as 'no arguments' (does not fall back to command-line parsing)", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ accessToken: "t1", expiresOn: FUTURE_ISO })));
      await resolver.resolve("srv", {
        kind: "command-based",
        command: "with space in path",
        args: [],
      });
      expect(runner.calls[0].argv).toEqual(["with space in path"]);
    });

    it("returns cached entry on subsequent resolve within expiry buffer", async () => {
      const { clock, runner, resolver } = buildResolver();
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t1", expiresOn: new Date(clock.now + 3600_000).toISOString() })),
      );
      const first = await resolver.resolve("srv", creds);
      clock.advance(60_000);
      const second = await resolver.resolve("srv", creds);
      expect(second).toEqual(first);
      expect(runner.calls).toHaveLength(1);
    });

    it("re-resolves when within refresh buffer of expiry", async () => {
      const { clock, runner, resolver } = buildResolver();
      const expiresAt = clock.now + 60_000;
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t1", expiresOn: new Date(expiresAt).toISOString() })),
      );
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t2", expiresOn: new Date(clock.now + 3600_000).toISOString() })),
      );
      await resolver.resolve("srv", creds);
      // Move within 5-minute default refresh buffer.
      clock.advance(60_000 - 10_000);
      const second = await resolver.resolve("srv", creds);
      expect(second?.authorization).toBe("Bearer t2");
      expect(runner.calls).toHaveLength(2);
    });

    it("returns expiresAt=null when expiry path missing", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ accessToken: "t1" })));
      const result = await resolver.resolve("srv", creds);
      expect(result?.expiresAt).toBeNull();
    });

    it("rate-limits re-resolves when expiry is unknown", async () => {
      const { clock, runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ accessToken: "t1" })));
      const first = await resolver.resolve("srv", creds);
      // Advance less than the rate-limit window — should hit cache.
      clock.advance(MIN_RERESOLVE_INTERVAL_MS - 1);
      const cached = await resolver.resolve("srv", creds);
      expect(cached).toEqual(first);
      expect(runner.calls).toHaveLength(1);

      // Advance past the window — should re-resolve.
      runner.enqueue(ok(JSON.stringify({ accessToken: "t2" })));
      clock.advance(2);
      const fresh = await resolver.resolve("srv", creds);
      expect(fresh?.authorization).toBe("Bearer t2");
      expect(runner.calls).toHaveLength(2);
    });

    it("respects custom tokenPath and expiryPath", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(
        ok(JSON.stringify({ result: { jwt: "t1", exp: 2_000_000_000 } })),
      );
      const result = await resolver.resolve("srv", {
        kind: "command-based",
        command: "fetch",
        tokenPath: "result.jwt",
        expiryPath: "result.exp",
      });
      expect(result?.authorization).toBe("Bearer t1");
      expect(result?.expiresAt).toBe(2_000_000_000 * 1000);
    });
  });

  describe("kind=command-based — error paths", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "azfail",
    };

    it("emits command-failed with truncated, sanitized stderr", async () => {
      const { runner, resolver } = buildResolver();
      const longStderr = "ERROR: ".concat(
        "x".repeat(MAX_STDERR_SNIPPET_LENGTH + 100),
      );
      runner.enqueue(fail(2, longStderr));
      const err = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      expect(err).toBeInstanceOf(CredentialResolutionFailed);
      expect(err.error.kind).toBe("command-failed");
      if (err.error.kind === "command-failed") {
        expect(err.error.exitCode).toBe(2);
      }
      expect(err.message.length).toBeLessThanOrEqual(
        MAX_STDERR_SNIPPET_LENGTH + 80,
      );
      expect(err.message.endsWith("…")).toBe(true);
    });

    it("emits command-failed without snippet when stderr is empty", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(fail(1, ""));
      const err = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      expect(err.error.kind).toBe("command-failed");
      expect(err.message).toBe("Credential command exited with code 1.");
    });

    it("redacts Authorization/Bearer/token patterns from stderr before surfacing", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(
        fail(
          2,
          "Authorization: Bearer leaky-token-AAA failed; also Bearer leaky-token-BBB; query ?token=leaky-token-CCC",
        ),
      );
      const err = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      expect(err.message).not.toContain("leaky-token-AAA");
      expect(err.message).not.toContain("leaky-token-BBB");
      expect(err.message).not.toContain("leaky-token-CCC");
      expect(err.message).toContain("[REDACTED]");
    });

    it("emits parse-failed referencing field names only when stdout is not JSON", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok("definitely not json with secret-token-12345"));
      try {
        await resolver.resolve("srv", creds);
        throw new Error("expected throw");
      } catch (e) {
        const err = e as CredentialResolutionFailed;
        expect(err.error.kind).toBe("parse-failed");
        expect(err.message).not.toContain("secret-token-12345");
        expect(err.message).toContain("accessToken");
        expect(err.message).toContain("expiresOn");
      }
    });

    it("emits token-path-missing with literal path in detail when token field absent", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok(JSON.stringify({ expiresOn: FUTURE_ISO })));
      try {
        await resolver.resolve("srv", {
          kind: "command-based",
          command: "az",
          tokenPath: "result.token",
        });
        throw new Error("expected throw");
      } catch (e) {
        const err = e as CredentialResolutionFailed;
        expect(err.error.kind).toBe("token-path-missing");
        if (err.error.kind === "token-path-missing") {
          expect(err.error.tokenPath).toBe("result.token");
        }
        expect(err.message).toBe("token field not found at path: result.token");
      }
    });

    it("distinguishes token-path-missing from parse-failed", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(ok("garbage"));
      const parseErr = await resolver
        .resolve("srvA", creds)
        .catch((e) => e as CredentialResolutionFailed);
      runner.enqueue(ok(JSON.stringify({ other: "field" })));
      const missingErr = await resolver
        .resolve("srvB", creds)
        .catch((e) => e as CredentialResolutionFailed);
      expect(parseErr.error.kind).toBe("parse-failed");
      expect(missingErr.error.kind).toBe("token-path-missing");
    });

    it("emits timeout error when runner reports timedOut=true", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
      try {
        await resolver.resolve("srv", creds);
        throw new Error("expected throw");
      } catch (e) {
        const err = e as CredentialResolutionFailed;
        expect(err.error.kind).toBe("timeout");
        expect(err.message).toContain("timed out");
        expect(err.message).toContain('"srv"');
      }
    });
  });

  describe("cache invalidation", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "az",
    };

    it("invalidate() forces next resolve to re-run command", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t1", expiresOn: new Date(clock.now + 3600_000).toISOString() })),
      );
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t2", expiresOn: new Date(clock.now + 3600_000).toISOString() })),
      );
      const first = await resolver.resolve("srv", creds);
      resolver.invalidate("srv");
      const second = await resolver.resolve("srv", creds);
      expect(first?.authorization).toBe("Bearer t1");
      expect(second?.authorization).toBe("Bearer t2");
      expect(runner.calls).toHaveLength(2);
    });

    it("invalidate() retains last-known tenant id", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-aaa",
          }),
        ),
      );
      await resolver.resolve("srv", creds);
      expect(resolver.getLastKnownTenantId("srv")).toBe("tenant-aaa");
      resolver.invalidate("srv");
      expect(resolver.getLastKnownTenantId("srv")).toBe("tenant-aaa");
    });

    it("clear() drops both token cache AND last-known tenant id", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-aaa",
          }),
        ),
      );
      await resolver.resolve("srv", creds);
      resolver.clear("srv");
      expect(resolver.getLastKnownTenantId("srv")).toBeNull();
    });
  });

  describe("tenant-id capture", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "az",
    };

    it("captures top-level tenant string from JSON output", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-xyz",
          }),
        ),
      );
      const result = await resolver.resolve("srv", creds);
      expect(result?.tenantId).toBe("tenant-xyz");
      expect(resolver.getLastKnownTenantId("srv")).toBe("tenant-xyz");
    });

    it("returns null tenantId when tenant field absent", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "t1", expiresOn: new Date(clock.now + 3600_000).toISOString() })),
      );
      const result = await resolver.resolve("srv", creds);
      expect(result?.tenantId).toBeNull();
      expect(resolver.getLastKnownTenantId("srv")).toBeNull();
    });

    it("ignores non-string tenant values", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: 42,
          }),
        ),
      );
      const result = await resolver.resolve("srv", creds);
      expect(result?.tenantId).toBeNull();
    });

    it("tenant id survives subsequent cache hits", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-cache",
          }),
        ),
      );
      await resolver.resolve("srv", creds);
      clock.advance(60_000);
      const cached = await resolver.resolve("srv", creds);
      expect(cached?.tenantId).toBe("tenant-cache");
    });
  });

  describe("per-server cache isolation", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "az",
    };

    it("two server ids with identical credentials maintain independent caches", async () => {
      const { runner, clock, resolver } = buildResolver();
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t-a",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-a",
          }),
        ),
      );
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t-b",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-b",
          }),
        ),
      );
      const a = await resolver.resolve("server-a", creds);
      const b = await resolver.resolve("server-b", creds);
      expect(a?.authorization).toBe("Bearer t-a");
      expect(b?.authorization).toBe("Bearer t-b");
      expect(runner.calls).toHaveLength(2);

      // Invalidating one must not affect the other's cache.
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t-a2",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
            tenant: "tenant-a",
          }),
        ),
      );
      resolver.invalidate("server-a");
      const aAgain = await resolver.resolve("server-a", creds);
      const bAgain = await resolver.resolve("server-b", creds);
      expect(aAgain?.authorization).toBe("Bearer t-a2");
      expect(bAgain?.authorization).toBe("Bearer t-b");
      // server-a re-ran (3rd call); server-b did NOT.
      expect(runner.calls).toHaveLength(3);
    });
  });

  describe("logging redaction (SC-006)", () => {
    let resolver: CredentialResolver;
    let runner: FakeRunner;
    let logger: CapturingLogger;

    beforeEach(() => {
      const built = buildResolver();
      resolver = built.resolver;
      runner = built.runner;
      logger = built.logger;
    });

    it("never logs token literal in success path", async () => {
      runner.enqueue(
        ok(JSON.stringify({ accessToken: "super-secret-token-12345", expiresOn: FUTURE_ISO })),
      );
      await resolver.resolve("srv", {
        kind: "command-based",
        command: "az",
      });
      for (const msg of logger.messages) {
        expect(msg).not.toContain("super-secret-token-12345");
      }
    });

    it("never includes token literal in any error message", async () => {
      runner.enqueue(ok('{"accessToken":"super-secret-12345","other":1}'));
      // expiry path defaults to expiresOn -> missing -> token resolves OK with expiresAt=null.
      // Force a token-path-missing scenario instead:
      runner.enqueue(ok('{"wrong":"super-secret-leak-67890"}'));
      await resolver.resolve("srvA", {
        kind: "command-based",
        command: "az",
      });
      try {
        await resolver.resolve("srvB", {
          kind: "command-based",
          command: "az",
        });
      } catch (e) {
        const err = e as CredentialResolutionFailed;
        expect(err.message).not.toContain("super-secret-leak-67890");
      }
      for (const msg of logger.messages) {
        expect(msg).not.toContain("super-secret-12345");
        expect(msg).not.toContain("super-secret-leak-67890");
      }
    });
  });

  describe("SM-5 / FR-007: rate-limit failed credential commands", () => {
    const creds: ServerCredentials = {
      kind: "command-based",
      command: "azfail",
    };

    it("two rapid failures within MIN_RERESOLVE_INTERVAL_MS only spawn the child once", async () => {
      const { clock, runner, resolver } = buildResolver();
      runner.enqueue(fail(1, "az not signed in"));
      // The second call must hit the failure cache; do NOT enqueue.
      const first = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      clock.advance(100);
      const second = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      expect(runner.calls).toHaveLength(1);
      expect(first).toBeInstanceOf(CredentialResolutionFailed);
      expect(second).toBeInstanceOf(CredentialResolutionFailed);
      expect(second).toBe(first);
    });

    it("failure cache expires after MIN_RERESOLVE_INTERVAL_MS so retry can occur", async () => {
      const { clock, runner, resolver } = buildResolver();
      runner.enqueue(fail(1, "az not signed in"));
      await resolver.resolve("srv", creds).catch(() => {});
      // Advance past the rate-limit window.
      clock.advance(MIN_RERESOLVE_INTERVAL_MS + 1);
      runner.enqueue(fail(1, "still broken"));
      await resolver.resolve("srv", creds).catch(() => {});
      expect(runner.calls).toHaveLength(2);
    });

    it("invalidate() clears failure cache so the next call re-runs the command", async () => {
      const { runner, resolver } = buildResolver();
      runner.enqueue(fail(1, "az not signed in"));
      await resolver.resolve("srv", creds).catch(() => {});
      resolver.invalidate("srv");
      runner.enqueue(fail(1, "still broken"));
      await resolver.resolve("srv", creds).catch(() => {});
      expect(runner.calls).toHaveLength(2);
    });

    it("a successful resolution after a failure resets the cache", async () => {
      const { clock, runner, resolver } = buildResolver();
      runner.enqueue(fail(1, "az not signed in"));
      await resolver.resolve("srv", creds).catch(() => {});
      // Advance past the rate-limit and succeed.
      clock.advance(MIN_RERESOLVE_INTERVAL_MS + 1);
      runner.enqueue(
        ok(
          JSON.stringify({
            accessToken: "t1",
            expiresOn: new Date(clock.now + 3600_000).toISOString(),
          }),
        ),
      );
      const success = await resolver.resolve("srv", creds);
      expect(success?.authorization).toBe("Bearer t1");
      // A subsequent failure within the rate-limit window should be a
      // fresh failure (cache was reset), not a cached one. Force a new
      // call by invalidating the success cache.
      resolver.invalidate("srv");
      runner.enqueue(fail(2, "broken again"));
      const fresh = await resolver
        .resolve("srv", creds)
        .catch((e) => e as CredentialResolutionFailed);
      // The runner saw 3 calls total: initial fail, success, fresh fail.
      expect(runner.calls).toHaveLength(3);
      expect(fresh.error.kind).toBe("command-failed");
    });
  });
});
