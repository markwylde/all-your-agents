import { spawn } from 'node:child_process';

// Runs each line of stdin as SQL on one connection it keeps open, as the `sqlite3` shell
// does, but through Node's own SQLite: runners are not guaranteed to have the shell.
const SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buf += chunk;
	const lines = buf.split('\\n');
	buf = lines.pop();
	for (const line of lines) if (line.trim()) db.exec(line);
});
process.stdin.on('end', () => db.close());
`;

/** A long-lived writer holding `db` open, fed one SQL line at a time on stdin. */
export function sqliteWriter(db: string) {
	const child = spawn(process.execPath, ['--no-warnings', '-e', SCRIPT, db], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	child.stdout.resume();
	return child;
}
