import { spawn } from 'node:child_process';

// Runs each line of stdin as SQL on one connection it keeps open, as the `sqlite3` shell
// does, but through Node's own SQLite: runners are not guaranteed to have the shell.
// Each line is acknowledged once committed.
const SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buf += chunk;
	const lines = buf.split('\\n');
	buf = lines.pop();
	for (const line of lines) {
		if (line.trim()) db.exec(line);
		process.stdout.write('ok\\n');
	}
});
process.stdin.on('end', () => db.close());
`;

/**
 * A long-lived writer holding `db` open, fed one SQL line at a time. `run` resolves once
 * that line is committed; `stdin` is there for callers that do not wait.
 */
export function sqliteWriter(db: string) {
	const child = spawn(process.execPath, ['--no-warnings', '-e', SCRIPT, db], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	const waiting: (() => void)[] = [];
	let pending = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		pending += chunk;
		let at = pending.indexOf('\n');
		while (at >= 0) {
			pending = pending.slice(at + 1);
			waiting.shift()?.();
			at = pending.indexOf('\n');
		}
	});
	const run = (sql: string): Promise<void> =>
		new Promise((resolve) => {
			waiting.push(resolve);
			child.stdin.write(`${sql}\n`);
		});
	return Object.assign(child, { run });
}
