import type { Session } from '../index.js';
import { fit, style, truncate, width } from './ansi.js';
import { folder, shortTime, value } from './format.js';

type Cell = (s: Session, now: number, home?: string) => string;

const COLUMNS: [string, Cell][] = [
	['STATUS', (s) => value(s.status)],
	['PID', (s) => value(s.pid)],
	['HARNESS', (s) => value(s.harness)],
	['TITLE', (s) => truncate(value(s.title), 60)],
	['FOLDER', (s, _n, home) => folder(s.cwd, home)],
	['DOING NOW', (s) => value(s.activity.tool?.name)],
	['SUB', (s) => (s.activity.openSubagents > 0 ? String(s.activity.openSubagents) : '-')],
	['MODEL', (s) => value(s.model)],
	['LAST TURN', (s) => value(s.activity.lastTurn)],
	['UPDATED', (s, now) => shortTime(s.updatedAt ?? s.startedAt, now)],
];

const RANK: Record<string, number> = { waiting: 0, running: 1, idle: 2 };

/** Plain-text table of live sessions, one header line then one line per session. */
export function formatTable(
	sessions: Session[],
	opts: { now: number; color: boolean; home?: string },
): string {
	const sorted = [...sessions].sort(
		(a, b) =>
			(RANK[a.status ?? ''] ?? 3) - (RANK[b.status ?? ''] ?? 3) ||
			(b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
	);
	const body = sorted.map((s) => COLUMNS.map(([, cell]) => cell(s, opts.now, opts.home)));
	const widths = COLUMNS.map(([label], i) =>
		Math.max(width(label), ...body.map((row) => width(row[i] ?? ''))),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => fit(cell, widths[i] ?? 0))
			.join('  ')
			.trimEnd();
	const out = [style(line(COLUMNS.map(([label]) => label)), ['bold'], opts.color)];
	for (const [i, row] of body.entries()) {
		const status = sorted[i]?.status;
		const text = line(row);
		if (status === 'waiting') out.push(style(text, ['yellow'], opts.color));
		else if (status === 'running') out.push(style(text, ['cyan'], opts.color));
		else out.push(text);
	}
	return `${out.join('\n')}\n`;
}

export function formatJson(sessions: Session[]): string {
	const rows = sessions.map((s) => ({
		id: s.id,
		harness: s.harness,
		provider: s.provider,
		pid: s.pid,
		status: s.status,
		waitingFor: s.waitingFor,
		title: s.title,
		cwd: s.cwd,
		model: s.model,
		kind: s.kind,
		startedAt: s.startedAt,
		updatedAt: s.updatedAt,
		activity: s.activity,
	}));
	return `${JSON.stringify(rows, null, 2)}\n`;
}
