import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_TIMEOUT_MS = 30_000;
const KILL_AFTER_MS = 32_000;
const ATTEMPTS = 3;

const costFile = join(tmpdir(), `aya-e2e-costs-${process.pid}.jsonl`);
writeFileSync(costFile, '');
process.env.AYA_E2E_COST_FILE = costFile;
process.env.AYA_LIVE = '1';

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), '../dist-test/test/e2e');
const files = readdirSync(e2eDir)
	.filter((name) => name.endsWith('.test.js'))
	.sort()
	.map((name) => join(e2eDir, name));

function runFile(file) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, file], {
			stdio: 'inherit',
			env: process.env,
		});
		const timer = setTimeout(() => {
			console.error(`  [e2e] ${file} exceeded ${TEST_TIMEOUT_MS / 1000}s — killing`);
			child.kill('SIGKILL');
		}, KILL_AFTER_MS);
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, signal, timedOut: signal === 'SIGKILL' });
		});
	});
}

async function runWithRetry(file) {
	let last = { code: 1, timedOut: false };
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		if (attempt > 1) {
			console.error(
				`  [e2e] retry ${attempt}/${ATTEMPTS}: ${file}${last.timedOut ? ' (timed out)' : ''}`,
			);
		}
		last = await runFile(file);
		if (last.code === 0) return last;
	}
	return last;
}

const results = await Promise.all(
	files.map(async (file) => ({ file, ...(await runWithRetry(file)) })),
);
const failed = results.filter((r) => r.code !== 0).map((r) => r.file);

if (existsSync(costFile)) {
	const rows = readFileSync(costFile, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const priced = rows.filter((r) => r.usd != null);
	const total = priced.reduce((s, r) => s + r.usd, 0);
	const top = [...priced].sort((a, b) => b.usd - a.usd).slice(0, 10);
	console.log('');
	console.log(`OpenRouter cost: $${total.toFixed(4)} (${priced.length} metered tests)`);
	console.log('Top expensive tests:');
	if (!top.length) {
		console.log('  (no usage deltas recorded)');
	} else {
		top.forEach((r, i) => {
			console.log(
				`  ${i + 1}. ${r.name}  $${Number(r.usd).toFixed(4)}  ${(r.ms / 1000).toFixed(1)}s`,
			);
		});
	}
}

if (failed.length) {
	console.error(`e2e failed after ${ATTEMPTS} attempts:`);
	for (const file of failed) console.error(`  ${file}`);
	process.exit(1);
}
process.exit(0);
