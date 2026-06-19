#!/usr/bin/env node
/**
 * Phase 3 release-notes extractor.
 *
 * Usage:
 *   tsx scripts/release/extract-release-notes.mjs <version> [<output-path>]
 *
 * Reads CHANGELOG.md at the repo root, extracts the section for the
 * supplied version (using `extractSection` from Phase 1's
 * `src/release/changelog.ts`), and writes it to <output-path> if given,
 * otherwise to stdout. Exits non-zero with a clear message when the
 * section is missing (FR-013 per Phase 3 spec line 440).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSection } from "../../src/release/changelog.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: tsx scripts/release/extract-release-notes.mjs <version> [<output-path>]",
    );
    process.exit(args.length === 0 ? 2 : 0);
  }
  const version = args[0];
  const outputPath = args[1];
  return { version, outputPath };
}

function main() {
  const { version, outputPath } = parseArgs(process.argv);
  const changelogPath = resolve(repoRoot, "CHANGELOG.md");
  let content;
  try {
    content = readFileSync(changelogPath, "utf8");
  } catch (err) {
    console.error(`[changelog:extract] Failed to read CHANGELOG.md: ${err.message}`);
    process.exit(1);
  }
  const section = extractSection(content, version);
  if (section === null) {
    console.error(
      `[changelog:extract] No section found for version ${version} in CHANGELOG.md`,
    );
    process.exit(1);
  }
  if (outputPath) {
    writeFileSync(resolve(repoRoot, outputPath), section, "utf8");
    console.error(`[changelog:extract] wrote ${section.length} chars to ${outputPath}`);
  } else {
    process.stdout.write(section);
  }
}

main();
