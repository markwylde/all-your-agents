import { fit, type Style, sanitize, style, truncate, width } from './ansi.js';
import { clockTime, folder, longTime, shortTime, statusText, subCount, value } from './format.js';
import { liveCounts, visibleRows } from './rows.js';
import { bodyHeight, type Row, type SortKey, type ViewState } from './state.js';

export type RenderOptions = {
	now: number;
	color: boolean;
	home?: string;
};

type Column = {
	id: string;
	label: string;
	size: number;
	/** Lower survives longer when the terminal is narrow. */
	priority: number;
	flex?: number;
	align?: 'left' | 'right';
	sort?: SortKey;
	cell: (row: Row, opts: RenderOptions) => string;
};

const COLUMNS: Column[] = [
	{ id: 'status', label: 'STATUS', size: 7, priority: 0, sort: 'status', cell: statusText },
	{
		id: 'pid',
		label: 'PID',
		size: 7,
		priority: 1,
		align: 'right',
		sort: 'pid',
		cell: (r) => value(r.pid),
	},
	{
		id: 'harness',
		label: 'HARNESS',
		size: 10,
		priority: 8,
		sort: 'harness',
		cell: (r) => value(r.harness),
	},
	{
		id: 'title',
		label: 'TITLE',
		size: 14,
		priority: 0,
		flex: 3,
		sort: 'title',
		cell: (r) => value(r.title),
	},
	{
		id: 'cwd',
		label: 'FOLDER',
		size: 12,
		priority: 2,
		flex: 2,
		sort: 'cwd',
		cell: (r, o) => folder(r.cwd, o.home),
	},
	{
		id: 'tool',
		label: 'DOING NOW',
		size: 12,
		priority: 3,
		cell: (r) => value(r.activity.tool?.name),
	},
	{ id: 'sub', label: 'SUB', size: 3, priority: 5, align: 'right', cell: subCount },
	{
		id: 'model',
		label: 'MODEL',
		size: 16,
		priority: 6,
		sort: 'model',
		cell: (r) => value(r.model),
	},
	{
		id: 'last',
		label: 'LAST TURN',
		size: 11,
		priority: 7,
		cell: (r) => value(r.activity.lastTurn),
	},
	{
		id: 'updated',
		label: 'UPDATED',
		size: 8,
		priority: 4,
		sort: 'updated',
		cell: (r, o) => shortTime(r.updatedAt ?? r.startedAt, o.now),
	},
];

const GUTTER = 2;
const GAP = 1;

function layout(cols: number): { col: Column; size: number }[] {
	let chosen = [...COLUMNS];
	const need = (list: Column[]) =>
		GUTTER + list.reduce((sum, c) => sum + c.size, 0) + GAP * Math.max(0, list.length - 1);
	while (need(chosen) > cols && chosen.some((c) => c.priority > 0)) {
		const drop = chosen.reduce((worst, c) => (c.priority > worst.priority ? c : worst));
		chosen = chosen.filter((c) => c !== drop);
	}
	let spare = Math.max(0, cols - need(chosen));
	const flexTotal = chosen.reduce((sum, c) => sum + (c.flex ?? 0), 0);
	const sizes = chosen.map((c) => {
		if (!c.flex || flexTotal === 0) return c.size;
		return c.size + Math.floor((spare * c.flex) / flexTotal);
	});
	spare -= sizes.reduce((s, n) => s + n, 0) - chosen.reduce((s, c) => s + c.size, 0);
	const titleIdx = chosen.findIndex((c) => c.id === 'title');
	if (titleIdx !== -1) sizes[titleIdx] = (sizes[titleIdx] ?? 0) + spare;
	return chosen.map((col, i) => ({ col, size: sizes[i] ?? col.size }));
}

const STATUS_STYLE: Record<string, Style[]> = {
	waiting: ['yellow', 'bold'],
	running: ['cyan'],
	idle: [],
	closed: ['dim'],
	'-': ['dim'],
};

function clip(line: string, cols: number): string {
	return truncate(line, cols);
}

function headerLine(state: ViewState, opts: RenderOptions): string {
	const c = opts.color;
	const left: string[] = [style(' aya', ['bold'], c)];
	if (!state.ready) {
		left.push(style('loading sessions…', ['dim'], c));
	} else {
		const n = liveCounts(state);
		left.push(`${n.live} live`);
		left.push(style(`${n.waiting} waiting`, n.waiting ? ['yellow', 'bold'] : [], c));
		left.push(style(`${n.running} running`, n.running ? ['cyan'] : [], c));
		left.push(`${n.idle} idle`);
	}
	if (state.filter) {
		const shown = visibleRows(state).length;
		const total = [...state.sessions.values()].filter((r) => state.showClosed || !r.closed).length;
		left.push(`filter: ${sanitize(state.filter)} ${shown}/${total}`);
	}
	if (state.showClosed) left.push(style('+closed', ['dim'], c));
	const right = `updated ${clockTime(opts.now)} `;
	const plainLeft = left.map((s) => s.replace(SGR, '')).join('  ');
	const spaceFor = state.cols - width(plainLeft) - width(right);
	if (spaceFor < 2) return clipStyled(left, state.cols, c);
	return `${left.join('  ')}${' '.repeat(spaceFor)}${style(right, ['dim'], c)}`;
}

/** Join styled segments, dropping trailing segments that do not fit. */
function clipStyled(parts: string[], cols: number, color: boolean): string {
	let out = '';
	let used = 0;
	for (const part of parts) {
		const plain = part.replace(SGR, '');
		const sep = out ? 2 : 0;
		if (used + sep + width(plain) > cols) {
			const room = cols - used - sep;
			if (room > 1) out += (sep ? '  ' : '') + style(truncate(plain, room), [], color);
			break;
		}
		out += (sep ? '  ' : '') + part;
		used += sep + width(plain);
	}
	return out;
}

function columnHeader(state: ViewState, cols: { col: Column; size: number }[], color: boolean) {
	const arrow = state.sort.desc ? '▼' : '▲';
	const cells = cols.map(({ col, size }) => {
		const label = col.sort === state.sort.key ? `${col.label}${arrow}` : col.label;
		return fit(label, size, col.align);
	});
	const line = fit(' '.repeat(GUTTER) + cells.join(' '.repeat(GAP)), state.cols);
	return color ? style(line, ['inverse'], true) : line;
}

function tableRow(
	row: Row,
	selected: boolean,
	cols: { col: Column; size: number }[],
	state: ViewState,
	opts: RenderOptions,
): string {
	const c = opts.color;
	const gutter = selected ? '> ' : '  ';
	if (selected && c) {
		const plain =
			gutter + cols.map(({ col, size }) => fit(col.cell(row, opts), size, col.align)).join(' ');
		return style(fit(plain, state.cols), ['inverse'], true);
	}
	const cells = cols.map(({ col, size }) => {
		const text = fit(col.cell(row, opts), size, col.align);
		if (row.closed) return text;
		if (col.id === 'status') return style(text, STATUS_STYLE[statusText(row)] ?? [], c);
		if (col.id === 'last' && row.activity.lastTurn === 'failed') return style(text, ['red'], c);
		return text;
	});
	const line = gutter + cells.join(' '.repeat(GAP));
	return row.closed ? style(line, ['dim'], c) : line;
}

function wrap(label: string, text: string, cols: number): string[] {
	const indent = 13;
	const room = Math.max(8, cols - indent - 1);
	const clean = sanitize(text);
	const lines: string[] = [];
	let rest = clean;
	do {
		let cut = '';
		let w = 0;
		for (const ch of rest) {
			const cw = width(ch);
			if (w + cw > room) break;
			cut += ch;
			w += cw;
		}
		if (cut === '') cut = rest.slice(0, 1);
		lines.push(`${lines.length === 0 ? ` ${label.padEnd(indent - 1)}` : ' '.repeat(indent)}${cut}`);
		rest = rest.slice(cut.length);
	} while (rest.length > 0);
	return lines;
}

function detailLines(row: Row, state: ViewState, opts: RenderOptions): string[] {
	const c = opts.color;
	const cols = state.cols;
	const a = row.activity;
	const lines: string[] = [];
	lines.push(...wrap('Session', row.id, cols));
	lines.push(...wrap('Title', value(row.title), cols));
	lines.push(...wrap('Folder', value(row.cwd), cols));
	lines.push(
		...wrap(
			'Harness',
			`${value(row.harness)} (${value(row.provider)})   kind ${value(row.kind)}   pid ${value(row.pid)}`,
			cols,
		),
	);
	const status = statusText(row);
	lines.push(style(` ${'Status'.padEnd(12)}${status}`, STATUS_STYLE[status] ?? [], c));
	if (row.waitingFor) lines.push(...wrap('Waiting for', row.waitingFor, cols));
	lines.push(...wrap('Model', value(row.model), cols));
	lines.push(
		...wrap(
			'Doing now',
			a.tool ? `${sanitize(a.tool.name)} since ${longTime(a.tool.startedAt, opts.now)}` : '-',
			cols,
		),
	);
	lines.push(
		...wrap(
			'Last turn',
			a.lastTurn ? `${a.lastTurn} at ${longTime(a.lastTurnEndedAt, opts.now)}` : '-',
			cols,
		),
	);
	if (a.error) lines.push(...wrap('Error', a.error, cols).map((l) => style(l, ['red'], c)));
	lines.push(
		...wrap(
			'Started',
			`${longTime(row.startedAt, opts.now)}   updated ${longTime(row.updatedAt, opts.now)}`,
			cols,
		),
	);
	lines.push('');
	lines.push(style(` Subagents (${row.subagents.length})`, ['bold'], c));
	if (row.subagents.length === 0) lines.push(style('   none', ['dim'], c));
	const subStyle: Record<string, Style[]> = {
		running: ['cyan'],
		failed: ['red'],
		cancelled: ['dim'],
	};
	for (const sub of row.subagents) {
		const line = `   ${fit(sub.status, 10)} ${fit(value(sub.type), 18)} ${fit(value(sub.title), 40)} ${sub.background ? 'background' : ''}`;
		lines.push(style(line.trimEnd(), subStyle[sub.status] ?? [], c));
	}
	return lines;
}

const HELP = [
	' Keys',
	'',
	'   ↑ ↓  k j        Move the selection',
	'   Home End        First / last row',
	'   PgUp PgDn       Page up / down',
	'   Enter           Open or close details for the selected session',
	'   /               Filter by title, folder, harness, model or pid',
	'   Esc             Clear the filter, close details',
	'   s >  <          Next / previous sort column',
	'   r               Reverse sort order',
	'   c               Show or hide closed sessions',
	'   ? h             Close this help',
	'   q  Ctrl+C       Quit',
	'',
	' Times are clock times. The screen changes only when an agent does.',
];

function footerLine(state: ViewState, opts: RenderOptions): string {
	const c = opts.color;
	if (state.prompt != null) return `/${sanitize(state.prompt)}${c ? '█' : '_'}`;
	if (state.lastError) {
		return style(
			` error [${sanitize(state.lastError.provider)}] ${sanitize(state.lastError.message)}`,
			['red'],
			c,
		);
	}
	const hints = state.help
		? ' ? close help   q quit'
		: state.detail
			? ' ⏎/Esc close details   ↑↓ select   q quit'
			: ' ↑↓ select  ⏎ details  / filter  s sort  r reverse  c closed  ? help  q quit';
	return style(hints, ['dim'], c);
}

/** Render a whole frame. Pure: same state and options give the same string. */
export function renderLines(state: ViewState, opts: RenderOptions): string[] {
	const cols = Math.max(1, state.cols);
	const height = bodyHeight(state);
	const lines: string[] = [headerLine(state, opts)];
	const layoutCols = layout(cols);
	const rows = visibleRows(state);

	let body: string[];
	if (state.help) {
		lines.push(style(fit(' Help', cols), ['inverse'], opts.color));
		body = HELP;
	} else if (state.detail && state.selectedId) {
		const row = state.sessions.get(state.selectedId);
		lines.push(style(fit(` ${value(row?.title)}`, cols), ['inverse'], opts.color));
		body = row ? detailLines(row, state, opts) : [];
	} else {
		lines.push(columnHeader(state, layoutCols, opts.color));
		body = rows
			.slice(state.scroll, state.scroll + height)
			.map((row, i) =>
				tableRow(row, state.scroll + i === state.selectedIndex, layoutCols, state, opts),
			);
		if (rows.length === 0 && state.ready) {
			body = [
				style(
					state.filter ? '  No sessions match the filter.' : '  No agents running.',
					['dim'],
					opts.color,
				),
			];
		}
	}
	for (let i = 0; i < height; i++) lines.push(body[i] ?? '');
	lines.push(footerLine(state, opts));
	return lines.map((line) => clipLine(line, cols));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR sequences
const SGR = /\x1b\[[0-9;]*m/g;

/** Cut a styled line to `cols` visible columns, keeping escapes and resetting at the end. */
function clipLine(line: string, cols: number): string {
	const plain = line.replace(SGR, '');
	if (width(plain) <= cols) return line;
	if (line === plain) return clip(line, cols);
	let out = '';
	let used = 0;
	let i = 0;
	while (i < line.length) {
		SGR.lastIndex = i;
		const m = line.startsWith('\x1b[', i) ? SGR.exec(line) : null;
		if (m && m.index === i) {
			out += m[0];
			i += m[0].length;
			continue;
		}
		const cp = line.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		const cw = width(ch);
		if (used + cw > cols - 1) {
			out += '…';
			break;
		}
		out += ch;
		used += cw;
		i += ch.length;
	}
	return `${out}\x1b[0m`;
}
