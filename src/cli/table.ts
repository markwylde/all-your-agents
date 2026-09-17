import type { Session } from '../index.ts';
import { fit, style, truncate, width } from './ansi.ts';
import { folder, shortTime, value } from './format.ts';

type Cell = (s: Session, now: number, home: string | undefined, live: boolean) => string;

/** Ids of the sessions that are live. Omitted when every session given is. */
export type LiveIds = ReadonlySet<string> | undefined;

const isLive = (s: Session, live: LiveIds): boolean => live?.has(s.id) ?? true;

const COLUMNS: [string, Cell][] = [
	['STATUS', (s, _n, _h, live) => (live ? value(s.status) : 'closed')],
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

/** Live sessions first, by status; then the rest. Newest first within each. */
export function displayOrder(sessions: Session[], live?: LiveIds): Session[] {
	const rank = (s: Session): number => (isLive(s, live) ? (RANK[s.status ?? ''] ?? 3) : 4);
	return [...sessions].sort(
		(a, b) =>
			rank(a) - rank(b) || (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
	);
}

/** Plain-text table of sessions, one header line then one line per session. */
export function formatTable(
	sessions: Session[],
	opts: { now: number; color: boolean; home?: string; live?: LiveIds },
): string {
	const sorted = displayOrder(sessions, opts.live);
	const body = sorted.map((s) =>
		COLUMNS.map(([, cell]) => cell(s, opts.now, opts.home, isLive(s, opts.live))),
	);
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
		const session = sorted[i];
		const status = session && isLive(session, opts.live) ? session.status : undefined;
		const text = line(row);
		if (status === 'waiting') out.push(style(text, ['yellow'], opts.color));
		else if (status === 'running') out.push(style(text, ['cyan'], opts.color));
		else out.push(text);
	}
	return `${out.join('\n')}\n`;
}

export function formatJson(sessions: Session[], live?: LiveIds): string {
	const rows = displayOrder(sessions, live).map((s) => ({
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
