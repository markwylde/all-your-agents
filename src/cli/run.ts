import { emitKeypressEvents } from 'node:readline';
import type { AgentsError, AllYourAgentsInstance, Session, Subagent } from '../index.ts';
import { CLEAR_LINE_END, CLEAR_SCREEN_END, ENTER_SCREEN, HOME, LEAVE_SCREEN } from './ansi.ts';
import { COMMAND, parseArgs, USAGE } from './args.ts';
import { type ReadlineKey, toKey } from './keys.ts';
import { renderLines } from './render.ts';
import { applyEvent, applyKey, initialState, type ViewEvent, type ViewState } from './state.ts';
import { formatJson, formatTable } from './table.ts';
import { createItemizer, type TranscriptItem } from './transcript.ts';

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

/** Where an error came from: the provider id, or the event whose listener threw. */
function origin(e: AgentsError): string {
	return e.source === 'provider' ? e.provider : e.event;
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
		aya.on('error', (e) => opts.stderr.write(`${COMMAND}: ${origin(e)}: ${message(e.error)}\n`));
		try {
			await aya.start();
			const running = aya.running();
			const sessions = args.history ? await aya.sessions() : running;
			const live = args.history ? new Set(running.map((s) => s.id)) : undefined;
			const text =
				args.mode === 'json'
					? formatJson(sessions, live)
					: formatTable(sessions, { now: now(), color, home, live });
			await write(opts.stdout, text);
			return 0;
		} finally {
			await aya.stop();
		}
	}

	return interactive(opts, { showClosed: args.all, history: args.history }, { now, color, home });
}

function interactive(
	opts: RunOptions,
	start: { showClosed: boolean; history: boolean },
	view: { now: () => number; color: boolean; home?: string },
): Promise<number> {
	const { stdin, stdout, stderr, proc } = opts;
	const aya = opts.createInstance();
	/** Every session seen, live or from history: the detail and transcript views read through it. */
	const known = new Map<string, Session>();
	let state: ViewState = initialState({
		cols: stdout.columns ?? 80,
		rows: stdout.rows ?? 24,
		...start,
	});
	let historyLoading = false;
	let stream: { stop(): void } | undefined;
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
		stream?.stop();
		stream = undefined;
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
				`${COMMAND}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
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
		const session = known.get(id);
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

	/** Read history once. The reducer asked for it by moving to `loading`. */
	const loadHistory = () => {
		if (historyLoading) return;
		historyLoading = true;
		aya
			.sessions()
			.catch((error: unknown) => {
				dispatch({ type: 'error', origin: 'history', message: message(error) });
				return [] as Session[];
			})
			.then((sessions) => {
				historyLoading = false;
				for (const s of sessions) if (!known.has(s.id)) known.set(s.id, s);
				dispatch({ type: 'history', sessions });
			});
	};

	/**
	 * Stream a session's events into the transcript view until it closes. Stored records
	 * arrive as one run of microtasks, so they are handed over per loop turn, not per
	 * record: one redraw for the backlog instead of thousands.
	 */
	const openTranscript = (sessionId: string): { stop(): void } | undefined => {
		const events = known.get(sessionId)?.events();
		if (!events) return undefined;
		const itemize = createItemizer();
		let buffer: TranscriptItem[] = [];
		let handing = false;
		let stopped = false;
		const handOver = () => {
			handing = false;
			if (stopped || buffer.length === 0) return;
			const items = buffer;
			buffer = [];
			dispatch({ type: 'transcript:append', sessionId, items });
		};
		(async () => {
			for await (const event of events) {
				if (stopped) break;
				const items = itemize(event);
				if (items.length === 0) continue;
				buffer.push(...items);
				if (!handing) {
					handing = true;
					setImmediate(handOver);
				}
			}
		})().catch((error: unknown) => {
			if (!stopped) dispatch({ type: 'error', origin: 'transcript', message: message(error) });
		});
		return {
			stop() {
				stopped = true;
				events.close();
			},
		};
	};

	const onSession =
		(name: 'create' | 'open' | 'status' | 'update' | 'activity' | 'close') =>
		(session: Session) => {
			known.set(session.id, session);
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
		for (const s of sessions) known.set(s.id, s);
		dispatch({ type: 'ready', live: sessions });
		if (state.history === 'loading') loadHistory();
	});
	aya.on('error', (e) => dispatch({ type: 'error', origin: origin(e), message: message(e.error) }));

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
		if (state.history === 'loading' && before.history !== 'loading' && state.ready) loadHistory();
		if (state.transcript?.sessionId !== before.transcript?.sessionId) {
			stream?.stop();
			stream = state.transcript ? openTranscript(state.transcript.sessionId) : undefined;
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
