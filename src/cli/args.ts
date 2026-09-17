export type CliMode = 'tui' | 'once' | 'json';

export type CliArgs = {
	mode: CliMode;
	all: boolean;
	help: boolean;
	version: boolean;
};

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

export const USAGE = `Usage: aya [options]

Watch every coding agent on this machine, like top.

Options:
  --once       Print a table of live sessions and exit
  --json       Print live sessions as JSON and exit
  --all        Show sessions that close while aya is open
  --help       Show this help
  --version    Print the version

Keys:
  ↑ ↓ / k j        Move the selection
  Home End         First / last row
  PgUp PgDn        Page up / down
  Enter            Open or close details for the selected session
  /                Filter by title, folder, harness, model or pid (Esc clears)
  s > / <          Next / previous sort column
  r                Reverse sort order
  c                Show or hide closed sessions
  ? h              Help
  q Ctrl+C         Quit

When stdout is not a terminal, aya behaves as if --once was given.
`;

export function parseArgs(argv: readonly string[]): ParseResult {
	const args: CliArgs = { mode: 'tui', all: false, help: false, version: false };
	for (const arg of argv) {
		switch (arg) {
			case '--once':
				if (args.mode !== 'json') args.mode = 'once';
				break;
			case '--json':
				args.mode = 'json';
				break;
			case '--all':
				args.all = true;
				break;
			case '--help':
			case '-h':
				args.help = true;
				break;
			case '--version':
			case '-v':
				args.version = true;
				break;
			default:
				return { ok: false, error: `aya: unknown option '${arg}'` };
		}
	}
	return { ok: true, args };
}
