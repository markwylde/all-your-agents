import { emitKeypressEvents } from 'node:readline';
import type { AllYourAgentsInstance, Session, Subagent } from '../index.js';
import { CLEAR_LINE_END, CLEAR_SCREEN_END, ENTER_SCREEN, HOME, LEAVE_SCREEN } from './ansi.js';
import { parseArgs, USAGE } from './args.js';
import { type ReadlineKey, toKey } from './keys.js';
import { renderLines } from './render.js';
import { applyEvent, applyKey, initialState, type ViewEvent, type ViewState } from './state.js';
import { formatJson, formatTable } from './table.js';

// biome-ignore lint/suspicious/noExplicitAny: must accept Node emitter listeners
type Listener = (...args: any[]) => void;

type Emitter = {
	on(event: string, listener: Listener): unknown;
	off(event: string, listener: Listener): unknown;
};

export type RunInput = Emitter & {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
};

export type RunOutput = Emitter & {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(chunk: string, cb?: () => void): unknown;
};

export type RunOptions = {
	argv: readonly string[];
	stdin: RunInput;
	stdout: RunOutput;
	stderr: { write(chunk: string): unknown };
	env: Record<string, string | undefined>;
	/** Receives SIGINT, SIGTERM, uncaughtException, unhandledRejection. Usually `process`. */
	proc: Emitter;
	version: string;
	createInstance: () => AllYourAgentsInstance;
	now?: () => number;
};

function write(out: RunOutput, text: string): Promise<void> {
	return new Promise((resolve) => {
		out.write(text, () => resolve());
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function run(opts: RunOptions): Promise<number> {
	const parsed = parseArgs(opts.argv);
	if (!parsed.ok) {
		opts.stderr.write(`${parsed.error}\n\n${USAGE}`);
		return 2;
	}
	const { args } = parsed;
	if (args.help) {
		await write(opts.stdout, USAGE);
		return 0;
	}
	if (args.version) {
		await write(opts.stdout, `${opts.version}\n`);
		return 0;
	}
	const now = opts.now ?? Date.now;
	const color = Boolean(opts.stdout.isTTY) && !opts.env.NO_COLOR;
	const home = opts.env.HOME;

	if (args.mode !== 'tui' || !opts.stdout.isTTY) {
		const aya = opts.createInstance();
		aya.on('error', (e) => opts.stderr.write(`aya: ${e.provider}: ${message(e.error)}\n`));
		try {
			await aya.start();
			const live = aya.running();
			const text =
				args.mode === 'json' ? formatJson(live) : formatTable(live, { now: now(), color, home });
			await write(opts.stdout, text);
			return 0;
		} finally {
			await aya.stop();
		}
	}

	return interactive(opts, args.all, { now, color, home });
}

function interactive(
	opts: RunOptions,
	showClosed: boolean,
	view: { now: () => number; color: boolean; home?: string },
): Promise<number> {
	const { stdin, stdout, stderr, proc } = opts;
	const aya = opts.createInstance();
	const live = new Map<string, Session>();
	let state: ViewState = initialState({
		cols: stdout.columns ?? 80,
		rows: stdout.rows ?? 24,
		showClosed,
	});
	let queued = false;
	let done = false;
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const cleanups: (() => void)[] = [];

	const listen = (target: Emitter, event: string, fn: Listener) => {
		target.on(event, fn);
		cleanups.push(() => target.off(event, fn));
	};

	const restore = () => {
		for (const fn of cleanups.splice(0)) fn();
		stdout.write(LEAVE_SCREEN);
		stdin.setRawMode?.(false);
		stdin.pause();
	};

	const finish = async (code: number, error?: unknown) => {
		if (done) return;
		done = true;
		restore();
		if (error !== undefined) {
			stderr.write(
				`aya: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
		}
		try {
			await aya.stop();
		} catch {}
		resolveExit(code);
	};

	const flush = () => {
		queued = false;
		if (done) return;
		try {
			const lines = renderLines(state, { now: view.now(), color: view.color, home: view.home });
			stdout.write(
				`${HOME}${lines.join(`${CLEAR_LINE_END}\r\n`)}${CLEAR_LINE_END}${CLEAR_SCREEN_END}`,
			);
		} catch (error) {
			void finish(1, error);
		}
	};

	const schedule = () => {
		if (queued || done) return;
		queued = true;
		queueMicrotask(flush);
	};

	const fetchSubagents = (id: string) => {
		const session = live.get(id);
		if (!session) return;
		session.subagents().then(
			(list: Subagent[]) => {
				if (done || !state.detail || state.selectedId !== id) return;
				dispatch({ type: 'subagents', sessionId: id, list });
			},
			() => {},
		);
	};

	const dispatch = (event: ViewEvent) => {
		if (done) return;
		state = applyEvent(state, event);
		schedule();
	};

	const onSession =
		(name: 'create' | 'open' | 'status' | 'update' | 'activity' | 'close') =>
		(session: Session) => {
			if (name === 'close') live.delete(session.id);
			else live.set(session.id, session);
			dispatch({ type: 'session', name, session });
		};

	for (const name of ['create', 'open', 'status', 'update', 'activity', 'close'] as const) {
		aya.on(`session:${name}` as 'session:create', onSession(name));
	}
	aya.on('subagent:start', (subagent, session) =>
		dispatch({ type: 'subagent', name: 'start', subagent, session }),
	);
	aya.on('subagent:end', (subagent, session) =>
		dispatch({ type: 'subagent', name: 'end', subagent, session }),
	);
	aya.on('ready', () => {
		const sessions = aya.running();
		live.clear();
		for (const s of sessions) live.set(s.id, s);
		dispatch({ type: 'ready', live: sessions });
	});
	aya.on('error', (e) =>
		dispatch({ type: 'error', provider: e.provider, message: message(e.error) }),
	);

	listen(stdin, 'keypress', ((str: string | undefined, raw: ReadlineKey | undefined) => {
		const key = toKey(str, raw);
		if (!key || done) return;
		const before = state;
		try {
			state = applyKey(state, key);
		} catch (error) {
			void finish(1, error);
			return;
		}
		if (state.quit) {
			void finish(0);
			return;
		}
		if (
			state.detail &&
			state.selectedId &&
			(!before.detail || before.selectedId !== state.selectedId)
		) {
			fetchSubagents(state.selectedId);
		}
		schedule();
	}) as Listener);
	listen(stdout, 'resize', (() =>
		dispatch({ type: 'resize', cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })) as Listener);
	listen(proc, 'SIGINT', (() => void finish(0)) as Listener);
	listen(proc, 'SIGTERM', (() => void finish(0)) as Listener);
	listen(proc, 'uncaughtException', ((error: unknown) => void finish(1, error)) as Listener);
	listen(proc, 'unhandledRejection', ((error: unknown) => void finish(1, error)) as Listener);

	stdout.write(ENTER_SCREEN);
	emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
	stdin.setRawMode?.(true);
	stdin.resume();
	schedule();

	aya.start().catch((error: unknown) => finish(1, error));
	return exited;
}
