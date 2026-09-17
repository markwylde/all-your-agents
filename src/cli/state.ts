import type {
	Session,
	SessionActivity,
	SessionKind,
	SessionStatus,
	Subagent,
	SubagentStatus,
} from '../index.ts';
import { visibleRows } from './rows.ts';

export type SubRow = {
	id: string;
	parentId?: string;
	type: string;
	title?: string;
	status: SubagentStatus;
	background: boolean;
	startedAt?: number;
	endedAt?: number;
};

export type Row = {
	id: string;
	harness: string;
	provider: string;
	pid?: number;
	status?: SessionStatus;
	waitingFor?: string;
	title?: string;
	cwd?: string;
	model?: string;
	kind?: SessionKind;
	startedAt?: number;
	updatedAt?: number;
	activity: SessionActivity;
	closed: boolean;
	subagents: SubRow[];
};

export const SORT_KEYS = ['status', 'pid', 'harness', 'title', 'cwd', 'model', 'updated'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type ViewState = {
	ready: boolean;
	sessions: ReadonlyMap<string, Row>;
	selectedId?: string;
	selectedIndex: number;
	scroll: number;
	sort: { key: SortKey; desc: boolean };
	filter: string;
	/** The filter being typed; undefined when the prompt is closed. */
	prompt?: string;
	detail: boolean;
	help: boolean;
	showClosed: boolean;
	lastError?: { provider: string; message: string };
	quit: boolean;
	cols: number;
	rows: number;
};

export type SessionLike = Pick<
	Session,
	| 'id'
	| 'harness'
	| 'provider'
	| 'pid'
	| 'status'
	| 'waitingFor'
	| 'title'
	| 'cwd'
	| 'model'
	| 'kind'
	| 'startedAt'
	| 'updatedAt'
	| 'activity'
>;

export type SubagentLike = Pick<
	Subagent,
	| 'id'
	| 'sessionId'
	| 'parentId'
	| 'type'
	| 'title'
	| 'status'
	| 'background'
	| 'startedAt'
	| 'endedAt'
>;

export type ViewEvent =
	| {
			type: 'session';
			name: 'create' | 'open' | 'status' | 'update' | 'activity' | 'close';
			session: SessionLike;
	  }
	| { type: 'subagent'; name: 'start' | 'end'; subagent: SubagentLike; session: SessionLike }
	| { type: 'subagents'; sessionId: string; list: SubagentLike[] }
	| { type: 'ready'; live: SessionLike[] }
	| { type: 'error'; provider: string; message: string }
	| { type: 'resize'; cols: number; rows: number };

export type Key =
	| 'up'
	| 'down'
	| 'home'
	| 'end'
	| 'pageup'
	| 'pagedown'
	| 'enter'
	| 'escape'
	| 'backspace'
	| 'ctrl-c'
	| { char: string };

export function initialState(opts: {
	cols: number;
	rows: number;
	showClosed?: boolean;
}): ViewState {
	return {
		ready: false,
		sessions: new Map(),
		selectedIndex: 0,
		scroll: 0,
		sort: { key: 'status', desc: false },
		filter: '',
		detail: false,
		help: false,
		showClosed: opts.showClosed ?? false,
		quit: false,
		cols: opts.cols,
		rows: opts.rows,
	};
}

/** Lines available for table rows: header, column header, and footer take three. */
export function bodyHeight(state: ViewState): number {
	return Math.max(1, state.rows - 3);
}

function snapshot(session: SessionLike, prev?: Row): Row {
	return {
		id: session.id,
		harness: session.harness,
		provider: session.provider,
		pid: session.pid,
		status: session.status,
		waitingFor: session.waitingFor,
		title: session.title,
		cwd: session.cwd,
		model: session.model,
		kind: session.kind,
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		activity: {
			...session.activity,
			tool: session.activity.tool ? { ...session.activity.tool } : undefined,
		},
		closed: false,
		subagents: prev?.subagents ?? [],
	};
}

function subSnapshot(sub: SubagentLike): SubRow {
	return {
		id: sub.id,
		parentId: sub.parentId,
		type: sub.type,
		title: sub.title,
		status: sub.status,
		background: sub.background,
		startedAt: sub.startedAt,
		endedAt: sub.endedAt,
	};
}

function upsertSub(list: SubRow[], sub: SubagentLike): SubRow[] {
	const next = subSnapshot(sub);
	const idx = list.findIndex((s) => s.id === sub.id);
	if (idx === -1) return [...list, next];
	const copy = [...list];
	copy[idx] = next;
	return copy;
}

/** Re-anchor selection and scroll after anything that can change the visible rows. */
export function normalize(state: ViewState): ViewState {
	const rows = visibleRows(state);
	let { selectedId, selectedIndex, scroll } = state;
	const found = selectedId == null ? -1 : rows.findIndex((r) => r.id === selectedId);
	if (found !== -1) {
		selectedIndex = found;
	} else if (rows.length > 0) {
		selectedIndex = Math.min(Math.max(selectedIndex, 0), rows.length - 1);
		selectedId = rows[selectedIndex]?.id;
	} else {
		selectedIndex = 0;
		selectedId = undefined;
	}
	const height = bodyHeight(state);
	if (selectedIndex < scroll) scroll = selectedIndex;
	if (selectedIndex >= scroll + height) scroll = selectedIndex - height + 1;
	scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)));
	const detail = state.detail && selectedId != null;
	return { ...state, selectedId, selectedIndex, scroll, detail };
}

export function applyEvent(state: ViewState, event: ViewEvent): ViewState {
	switch (event.type) {
		case 'session': {
			const sessions = new Map(state.sessions);
			const prev = sessions.get(event.session.id);
			const row = snapshot(event.session, prev);
			if (event.name === 'close') {
				row.closed = true;
				row.pid = undefined;
			}
			sessions.set(row.id, row);
			return normalize({ ...state, sessions });
		}
		case 'subagent':
		case 'subagents': {
			const sessionId = event.type === 'subagent' ? event.session.id : event.sessionId;
			const sessions = new Map(state.sessions);
			const prev = sessions.get(sessionId);
			const base = prev ?? (event.type === 'subagent' ? snapshot(event.session) : undefined);
			if (!base) return state;
			let subagents = base.subagents;
			if (event.type === 'subagent') {
				subagents = upsertSub(subagents, event.subagent);
			} else {
				for (const sub of event.list) subagents = upsertSub(subagents, sub);
			}
			sessions.set(sessionId, { ...base, subagents });
			return normalize({ ...state, sessions });
		}
		case 'ready': {
			const sessions = new Map<string, Row>();
			const liveIds = new Set(event.live.map((s) => s.id));
			for (const [id, row] of state.sessions) {
				if (row.closed && !liveIds.has(id)) sessions.set(id, row);
			}
			for (const s of event.live) sessions.set(s.id, snapshot(s, state.sessions.get(s.id)));
			const fresh = state.ready ? {} : { selectedId: undefined, selectedIndex: 0, scroll: 0 };
			return normalize({ ...state, ...fresh, sessions, ready: true });
		}
		case 'error':
			return { ...state, lastError: { provider: event.provider, message: event.message } };
		case 'resize':
			return normalize({ ...state, cols: event.cols, rows: event.rows });
	}
}

function move(state: ViewState, delta: number): ViewState {
	const count = visibleRows(state).length;
	if (count === 0) return state;
	const index = Math.min(Math.max(state.selectedIndex + delta, 0), count - 1);
	return normalize({ ...state, selectedIndex: index, selectedId: undefined });
}

function cycleSort(state: ViewState, step: number): ViewState {
	const i = SORT_KEYS.indexOf(state.sort.key);
	const key = SORT_KEYS[(i + step + SORT_KEYS.length) % SORT_KEYS.length] ?? 'status';
	return normalize({ ...state, sort: { key, desc: false } });
}

export function applyKey(input: ViewState, key: Key): ViewState {
	if (key === 'ctrl-c') return { ...input, quit: true };
	const state = input.lastError ? { ...input, lastError: undefined } : input;

	if (state.prompt != null) {
		if (key === 'enter')
			return normalize({ ...state, filter: state.prompt.trim(), prompt: undefined });
		if (key === 'escape') return normalize({ ...state, filter: '', prompt: undefined });
		if (key === 'backspace') return { ...state, prompt: state.prompt.slice(0, -1) };
		if (typeof key === 'object') return { ...state, prompt: state.prompt + key.char };
		return state;
	}

	if (state.help) {
		if (typeof key === 'object' && key.char === 'q') return { ...state, quit: true };
		if (key === 'escape' || (typeof key === 'object' && (key.char === '?' || key.char === 'h'))) {
			return { ...state, help: false };
		}
		return state;
	}

	const page = bodyHeight(state);
	switch (key) {
		case 'up':
			return move(state, -1);
		case 'down':
			return move(state, 1);
		case 'home':
			return move(state, -Number.MAX_SAFE_INTEGER);
		case 'end':
			return move(state, Number.MAX_SAFE_INTEGER);
		case 'pageup':
			return move(state, -page);
		case 'pagedown':
			return move(state, page);
		case 'enter':
			return state.selectedId == null ? state : { ...state, detail: !state.detail };
		case 'escape':
			if (state.detail) return { ...state, detail: false };
			if (state.filter) return normalize({ ...state, filter: '' });
			return state;
		case 'backspace':
			return state;
	}

	switch (key.char) {
		case 'k':
			return move(state, -1);
		case 'j':
			return move(state, 1);
		case 's':
		case '>':
			return cycleSort(state, 1);
		case '<':
			return cycleSort(state, -1);
		case 'r':
			return normalize({ ...state, sort: { ...state.sort, desc: !state.sort.desc } });
		case '/':
			return { ...state, prompt: state.filter };
		case 'c':
			return normalize({ ...state, showClosed: !state.showClosed });
		case '?':
		case 'h':
			return { ...state, help: true };
		case 'q':
			return { ...state, quit: true };
		default:
			return state;
	}
}
