import type { Row, ViewState } from './state.js';

const STATUS_RANK: Record<string, number> = { waiting: 0, running: 1, idle: 2 };

function statusRank(row: Row): number {
	if (row.closed) return 4;
	return row.status ? (STATUS_RANK[row.status] ?? 3) : 3;
}

function updated(row: Row): number {
	return row.updatedAt ?? row.startedAt ?? 0;
}

function text(value: string | number | undefined): string {
	return value == null ? '' : String(value).toLowerCase();
}

export function matchesFilter(row: Row, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return [row.title, row.cwd, row.harness, row.model, row.pid].some((v) =>
		text(v).includes(needle),
	);
}

function compare(a: Row, b: Row, key: ViewState['sort']['key']): number {
	switch (key) {
		case 'status':
			return statusRank(a) - statusRank(b) || updated(b) - updated(a);
		case 'pid':
			return (a.pid ?? Number.MAX_SAFE_INTEGER) - (b.pid ?? Number.MAX_SAFE_INTEGER);
		case 'updated':
			return updated(b) - updated(a);
		default:
			return text(a[key]).localeCompare(text(b[key]));
	}
}

/** Sessions to show, filtered and sorted, in display order. */
export function visibleRows(state: ViewState): Row[] {
	const rows = [...state.sessions.values()].filter(
		(row) => (state.showClosed || !row.closed) && matchesFilter(row, state.filter),
	);
	rows.sort((a, b) => {
		const c = compare(a, b, state.sort.key);
		return (state.sort.desc ? -c : c) || a.id.localeCompare(b.id);
	});
	return rows;
}

export function liveCounts(state: ViewState): {
	live: number;
	running: number;
	waiting: number;
	idle: number;
} {
	const counts = { live: 0, running: 0, waiting: 0, idle: 0 };
	for (const row of state.sessions.values()) {
		if (row.closed) continue;
		counts.live++;
		if (row.status) counts[row.status]++;
	}
	return counts;
}
