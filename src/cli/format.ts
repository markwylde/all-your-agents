import { sanitize } from './ansi.ts';
import type { Row } from './state.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

export function clockTime(at: number): string {
	const d = new Date(at);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `HH:MM:SS` for today, `Mon DD` otherwise. Absolute on purpose: nothing ticks. */
export function shortTime(at: number | undefined, now: number): string {
	if (at == null) return '-';
	const d = new Date(at);
	const n = new Date(now);
	if (d.toDateString() === n.toDateString()) return clockTime(at);
	return `${MONTHS[d.getMonth()]} ${pad2(d.getDate())}`;
}

export function longTime(at: number | undefined, now: number): string {
	if (at == null) return '-';
	const d = new Date(at);
	const n = new Date(now);
	if (d.toDateString() === n.toDateString()) return clockTime(at);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockTime(at)}`;
}

export function value(v: string | number | undefined): string {
	return v == null || v === '' ? '-' : sanitize(String(v));
}

export function folder(cwd: string | undefined, home: string | undefined): string {
	if (!cwd) return '-';
	const clean = sanitize(cwd);
	if (home && (clean === home || clean.startsWith(`${home}/`)))
		return `~${clean.slice(home.length)}`;
	return clean;
}

export function statusText(row: Row): string {
	return row.closed ? 'closed' : (row.status ?? '-');
}

export function subCount(row: Row): string {
	const n = row.activity.openSubagents;
	return n > 0 ? String(n) : '-';
}
