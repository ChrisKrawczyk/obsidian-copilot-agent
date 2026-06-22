/**
 * Tokenize a command-line string into an argv array.
 *
 * This is the same lightweight parser used by the settings form
 * (`mcpServerFormLogic.parseArgs`) and the credential resolver's fallback
 * path: it recognizes double- and single-quoted segments and otherwise
 * splits on whitespace. There is no escape-character handling — quoting
 * is the only mechanism to embed whitespace.
 *
 * Lives in a credentials-scoped module so consumers don't have to import
 * from the settings layer.
 */
export function parseCommandLine(raw: string): string[] {
  const argv: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    argv.push(match[1] ?? match[2] ?? match[3]);
  }
  return argv;
}
