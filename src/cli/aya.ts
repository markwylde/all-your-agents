#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { AllYourAgents } from '../index.js';
import { run } from './run.js';

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
		return String(pkg.version);
	} catch {
		return 'unknown';
	}
}

run({
	argv: process.argv.slice(2),
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	env: process.env,
	proc: process,
	version: readVersion(),
	createInstance: () => AllYourAgents(),
}).then(
	(code) => {
		// Let the event loop drain rather than exit(): exiting while the process-watch
		// worker is still loading its native module aborts the process.
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`aya: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
