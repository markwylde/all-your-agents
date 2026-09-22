import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Runs the suite, then reruns each failed test on its own, up to 3 attempts in all.
const ATTEMPTS = 3;
const reporter = new URL('./failed-tests-reporter.mjs', import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), 'aya-tests-'));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const run = (attempt, files, names = []) => {
	const out = join(dir, `failed-${attempt}.json`);
	spawnSync(
		process.execPath,
		[
			'--test',
			'--test-force-exit',
			'--test-timeout=60000',
			'--test-reporter=spec',
			'--test-reporter-destination=stdout',
			`--test-reporter=${reporter}`,
			`--test-reporter-destination=${out}`,
			...names.flatMap((name) => ['--test-name-pattern', `^${escape(name)}$`]),
			...files,
		],
		{ stdio: 'inherit' },
	);
	return JSON.parse(readFileSync(out, 'utf8'));
};

/** A file that fails outside any test is reported under its own path: rerun all of it. */
const regroup = (failed) => {
	const byFile = new Map();
	for (const { file, name } of failed) {
		const path = resolve(file ?? name);
		const names = byFile.get(path) ?? [];
		names.push(resolve(name) === path ? undefined : name);
		byFile.set(path, names);
	}
	return [...byFile].map(([file, names]) => ({
		file,
		names: names.includes(undefined) ? [] : names,
	}));
};

const label = (file, name) =>
	name && resolve(name) !== resolve(file)
		? `${relative('.', file)} › ${name}`
		: relative('.', file);

try {
	let failed = run(1, process.argv.slice(2));
	const flaky = [];
	for (let attempt = 2; attempt <= ATTEMPTS && failed.length > 0; attempt++) {
		const still = [];
		for (const { file, names } of regroup(failed)) {
			const wanted = names.length > 0 ? names : [undefined];
			console.log(
				`\n↻ attempt ${attempt}/${ATTEMPTS}: ${wanted.map((n) => label(file, n)).join(', ')}`,
			);
			const again = run(attempt, [file], names);
			still.push(...again);
			if (again.length === 0) flaky.push(...wanted.map((n) => label(file, n)));
			else
				flaky.push(
					...names.filter((n) => !again.some((f) => f.name === n)).map((n) => label(file, n)),
				);
		}
		failed = still;
	}
	if (flaky.length > 0) console.log(`\n⚠ passed on retry: ${flaky.join(', ')}`);
	if (failed.length > 0) {
		console.log(
			`\n✖ failed ${ATTEMPTS} times: ${failed.map((f) => label(f.file ?? f.name, f.name)).join(', ')}`,
		);
		process.exitCode = 1;
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
