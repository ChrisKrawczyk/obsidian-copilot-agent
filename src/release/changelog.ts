export interface SectionRange {
  startLine: number;
  endLine: number;
}

const HEADING_RE = /^##\s+\[([^\]]+)\]/;

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function joinLines(lines: string[], original: string): string {
  const eol = /\r\n/.test(original) ? "\r\n" : "\n";
  return lines.join(eol);
}

export function findSection(content: string, version: string): SectionRange | null {
  const lines = splitLines(content);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1] === version) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length - 1;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s+\[/.test(lines[j])) {
      end = j - 1;
      break;
    }
  }
  return { startLine: start, endLine: end };
}

export function extractSection(content: string, version: string): string | null {
  const range = findSection(content, version);
  if (!range) return null;
  const lines = splitLines(content).slice(range.startLine, range.endLine + 1);
  return joinLines(lines, content);
}

export interface InsertResult {
  content: string;
  inserted: boolean;
}

function findFirstSectionLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) return i;
  }
  return -1;
}

export function insertStubSection(
  content: string,
  version: string,
  date: string,
): InsertResult {
  if (findSection(content, version)) {
    return { content, inserted: false };
  }
  const lines = splitLines(content);
  const stub = [
    `## [${version}] - ${date}`,
    "",
    "### Added",
    "",
  ];
  const firstSection = findFirstSectionLine(lines);
  if (firstSection === -1) {
    const trailing = lines.length > 0 && lines[lines.length - 1].trim() !== "" ? [""] : [];
    const next = [...lines, ...trailing, ...stub, ""];
    return { content: joinLines(next, content), inserted: true };
  }
  const insertAt = firstSection;
  const trailingBlank = ["", ""];
  const next = [
    ...lines.slice(0, insertAt),
    ...stub,
    ...trailingBlank.slice(0, 1),
    ...lines.slice(insertAt),
  ];
  return { content: joinLines(next, content), inserted: true };
}

export function normalizeUnreleasedHeading(
  content: string,
  version: string,
  date: string,
): string {
  const lines = splitLines(content);
  const wantUnreleased = `## [Unreleased]`;
  const wantVersionUnreleased = `## [${version}]`;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trimEnd() === wantUnreleased || /^##\s+\[Unreleased\]/.test(ln)) {
      lines[i] = `## [${version}] - ${date}`;
      return joinLines(lines, content);
    }
    if (ln.startsWith(wantVersionUnreleased) && /unreleased/i.test(ln)) {
      lines[i] = `## [${version}] - ${date}`;
      return joinLines(lines, content);
    }
  }
  return content;
}
