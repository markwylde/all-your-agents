import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type CostRow = {
	name: string;
	usd: number | null;
	ms: number;
	at: number;
};

function costFile(): string {
	return process.env.AYA_E2E_COST_FILE ?? join(tmpdir(), 'aya-e2e-costs.jsonl');
}

export async function readOpenRouterUsage(): Promise<number | null> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return null;
	try {
		const res = await fetch('https://openrouter.ai/api/v1/key', {
			headers: { Authorization: `Bearer ${key}` },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: { usage?: number } };
		return typeof body.data?.usage === 'number' ? body.data.usage : null;
	} catch {
		return null;
	}
}

export async function measureCost<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const before = await readOpenRouterUsage();
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const after = await readOpenRouterUsage();
		const usd = before != null && after != null ? Math.max(0, after - before) : null;
		const row: CostRow = { name, usd, ms: Date.now() - t0, at: Date.now() };
		appendFileSync(costFile(), `${JSON.stringify(row)}\n`);
		const label = usd == null ? 'n/a' : `$${usd.toFixed(4)}`;
		console.log(`  [openrouter] ${name}: ${label} in ${(row.ms / 1000).toFixed(1)}s`);
	}
}

export function readCostRows(): CostRow[] {
	const path = costFile();
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CostRow);
}

export function formatCostReport(rows: CostRow[]): string {
	const priced = rows.filter((r): r is CostRow & { usd: number } => r.usd != null);
	const total = priced.reduce((sum, r) => sum + r.usd, 0);
	const top = [...priced].sort((a, b) => b.usd - a.usd).slice(0, 10);
	const lines = [
		`OpenRouter cost: $${total.toFixed(4)} (${priced.length} metered tests)`,
		'Top expensive tests:',
	];
	if (!top.length) {
		lines.push('  (no usage deltas recorded — OpenRouter /api/v1/key may lag)');
	} else {
		for (const [i, r] of top.entries()) {
			lines.push(`  ${i + 1}. ${r.name}  $${r.usd.toFixed(4)}  ${(r.ms / 1000).toFixed(1)}s`);
		}
	}
	return lines.join('\n');
}

export function resetCostFile(): void {
	writeFileSync(costFile(), '');
}
