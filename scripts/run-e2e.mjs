import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const costFile = join(tmpdir(), `aya-e2e-costs-${process.pid}.jsonl`);
writeFileSync(costFile, '');
process.env.AYA_E2E_COST_FILE = costFile;
process.env.AYA_LIVE = '1';

const node = spawn(process.execPath, ['--test', 'dist-test/test/e2e/**/*.test.js'], {
	stdio: 'inherit',
	env: process.env,
});

node.on('exit', async (code) => {
	const { readFileSync, existsSync } = await import('node:fs');
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
	process.exit(code ?? 1);
});
