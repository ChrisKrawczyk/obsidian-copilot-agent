#!/usr/bin/env node
/**
 * Extract PR bodies for squash-merge commits in a git range.
 *
 * Usage:
 *   tsx scripts/release/extract-pr-body.mjs <previous-tag-or-ref>
 *
 * Background:
 *   This repo's convention is to squash-merge feature branches to `main`. Each
 *   squash-merge produces a single non-merge commit on `main` whose subject
 *   ends with `(#N)`, where N is the merged PR number. For the release agent's
 *   `changelog-draft` skill, the PR body is a much richer source than the
 *   single squash commit subject — it carries the full release narrative the
 *   author wrote.
 *
 * Behavior:
 *   1. Run `git log <previous-ref>..HEAD --no-merges --pretty=format:%H%x09%s`
 *      and parse each commit subject for a trailing `(#N)`.
 *   2. For each captured PR number, call `gh pr view <N> --json number,title,body,mergedAt,author`.
 *   3. Print a Markdown skeleton to stdout suitable for the CHANGELOG draft:
 *
 *        # PR #6 — [v0.6 — Packaging & Release] First BRAT-installable...
 *        _Authored by chriskrawczyk, merged 2026-06-19_
 *
 *        <PR body>
 *
 *        ---
 *
 *   4. If no PR-suffixed commits are found in range, print a single
 *      `# (no squash-merged PRs in range)` line and exit 0 — the
 *      caller falls back to standard `git log` content.
 *
 * Exit codes:
 *   0 — success (may produce the "no PRs" sentinel — that's not an error).
 *   1 — `gh` not authenticated, invalid range, or any other failure.
 *
 * Notes:
 *   - This script does NOT mutate state. Pure read.
 *   - On a multi-account `gh` host, run `gh auth status` before invoking and
 *     `gh auth switch --user <correct>` if needed. The script does not enforce
 *     this — it surfaces the gh error verbatim.
 */
import { execFileSync } from "node:child_process";

const PR_SUFFIX_RE = /\s\(#(\d+)\)\s*$/;

function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    ...opts,
  });
}

function listCommitsInRange(previousRef) {
  const range = previousRef ? `${previousRef}..HEAD` : "HEAD";
  const raw = run("git", ["log", range, "--no-merges", "--pretty=format:%H%x09%s"]);
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [sha, ...subjectParts] = line.split("\t");
      return { sha, subject: subjectParts.join("\t") };
    });
}

function extractPrNumber(subject) {
  const match = PR_SUFFIX_RE.exec(subject);
  return match ? Number(match[1]) : null;
}

function fetchPr(prNumber) {
  const raw = run("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,body,mergedAt,author",
  ]);
  return JSON.parse(raw);
}

function renderSection(pr) {
  const mergedDate = pr.mergedAt ? pr.mergedAt.slice(0, 10) : "unknown";
  const authorLogin = pr.author && pr.author.login ? pr.author.login : "unknown";
  return [
    `# PR #${pr.number} — ${pr.title}`,
    `_Authored by ${authorLogin}, merged ${mergedDate}_`,
    "",
    pr.body || "_(empty PR body)_",
    "",
    "---",
    "",
  ].join("\n");
}

function main() {
  const previousRef = process.argv[2];
  if (!previousRef) {
    process.stderr.write(
      "Usage: tsx scripts/release/extract-pr-body.mjs <previous-tag-or-ref>\n",
    );
    process.exit(1);
  }

  let commits;
  try {
    commits = listCommitsInRange(previousRef);
  } catch (err) {
    process.stderr.write(`[extract-pr-body] git log failed: ${err.message}\n`);
    process.exit(1);
  }

  const prNumbers = commits
    .map((c) => extractPrNumber(c.subject))
    .filter((n) => n !== null);

  if (prNumbers.length === 0) {
    process.stdout.write("# (no squash-merged PRs in range)\n");
    process.exit(0);
  }

  const sections = [];
  for (const n of prNumbers) {
    try {
      const pr = fetchPr(n);
      sections.push(renderSection(pr));
    } catch (err) {
      process.stderr.write(`[extract-pr-body] gh pr view ${n} failed: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(sections.join("\n"));
}

main();
