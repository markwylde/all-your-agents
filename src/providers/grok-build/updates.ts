import type { WatchContext } from '../../provider.ts';

/** The `method` of Grok's own rows in `updates.jsonl`; every other row is a streamed chunk. */
export const XAI_UPDATE = '_x.ai/session/update';

/** How much of `updates.jsonl` one read takes: the file runs to megabytes a turn. */
export const UPDATES_READ_BYTES = 4 * 1024 * 1024;

/** A background task as its latest row left it. Only `running` counts as running. */
export type BackgroundTask = { kind: string; status: string };

export type TaskMap = Map<string, BackgroundTask>;

export type TaskUpdate =
	| { type: 'snapshot'; tasks: TaskMap }
	| { type: 'completed'; taskId: string };

/**
 * One `updates.jsonl` line as a task update. Anything but a `background_tasks` or
 * `task_completed` row is none, a torn line included. Throws for one of those two rows
 * that lacks what it is read for.
 */
export function parseUpdateLine(line: string): TaskUpdate | undefined {
	// One row per streamed chunk; parse only the lines that can matter.
	if (!line.includes(XAI_UPDATE)) return undefined;
	let rec: unknown;
	try {
		rec = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (row.method !== XAI_UPDATE) return undefined;
	const update = (row.params as Record<string, unknown> | undefined)?.update;
	if (!update || typeof update !== 'object') return undefined;
	const u = update as Record<string, unknown>;
	if (u.sessionUpdate === 'background_tasks') {
		if (!Array.isArray(u.tasks)) throw new Error('grok-build: background_tasks row without tasks');
		const tasks: TaskMap = new Map();
		for (const task of u.tasks) {
			if (!task || typeof task !== 'object') continue;
			const t = task as Record<string, unknown>;
			if (typeof t.task_id !== 'string') continue;
			tasks.set(t.task_id, {
				kind: typeof t.kind === 'string' ? t.kind : '',
				status: typeof t.status === 'string' ? t.status : '',
			});
		}
		return { type: 'snapshot', tasks };
	}
	if (u.sessionUpdate === 'task_completed') {
		const taskId = (u.task_snapshot as Record<string, unknown> | undefined)?.task_id;
		if (typeof taskId !== 'string')
			throw new Error('grok-build: task_completed row without task_id');
		return { type: 'completed', taskId };
	}
	return undefined;
}

/** A snapshot replaces every known task; a completion only ends the one it names. */
export function applyTaskUpdate(tasks: TaskMap, update: TaskUpdate): void {
	if (update.type === 'snapshot') {
		tasks.clear();
		for (const [id, task] of update.tasks) tasks.set(id, task);
		return;
	}
	const task = tasks.get(update.taskId);
	if (task?.status === 'running') task.status = 'completed';
}

/** Apply every complete line of `text`. A bad row is reported and changes nothing. */
export function applyUpdateLines(
	tasks: TaskMap,
	text: string,
	onFailure: (error: unknown) => void,
): boolean {
	let changed = false;
	for (const line of text.split('\n')) {
		try {
			const update = parseUpdateLine(line);
			if (!update) continue;
			applyTaskUpdate(tasks, update);
			changed = true;
		} catch (error) {
			onFailure(error);
		}
	}
	return changed;
}

/** What `waitingFor` says while these tasks outlive the turn: a monitor is sure to wake it. */
export function backgroundWait(tasks: TaskMap): 'monitor' | 'shell' | undefined {
	let wait: 'shell' | undefined;
	for (const task of tasks.values()) {
		if (task.status !== 'running') continue;
		if (task.kind === 'monitor') return 'monitor';
		wait = 'shell';
	}
	return wait;
}

/**
 * Follow `updates.jsonl` from its top: what is there first, then what is appended. The
 * file may not exist, now or ever; one that shrinks is read from the top again.
 * `onChange` is called after a read that applied a task row. `read()` looks now, and
 * resolves once everything written so far has been applied.
 */
export function followUpdates(
	ctx: WatchContext,
	path: string,
	tasks: () => TaskMap,
	onChange: () => void,
): { close(): void; read(): Promise<void> } {
	let closed = false;
	let offset = 0;
	let partial = '';
	// Reads end wherever the writer happens to be, which can be inside a character.
	let decoder = new TextDecoder();
	let pending: Promise<void> = Promise.resolve();

	const readToEnd = async (): Promise<void> => {
		const st = await ctx.fs.stat(path).catch(() => null);
		if (closed || !st) return;
		if (st.size < offset) {
			offset = 0;
			partial = '';
			decoder = new TextDecoder();
		}
		let changed = false;
		while (offset < st.size) {
			const end = Math.min(st.size, offset + UPDATES_READ_BYTES);
			const bytes = await ctx.fs.readRange(path, offset, end);
			if (closed) return;
			if (bytes.byteLength === 0) break;
			offset += bytes.byteLength;
			const text = partial + decoder.decode(bytes, { stream: true });
			const cut = text.lastIndexOf('\n');
			partial = text.slice(cut + 1);
			if (applyUpdateLines(tasks(), text.slice(0, cut + 1), ctx.reportError)) changed = true;
		}
		if (changed) onChange();
	};

	const read = (): Promise<void> => {
		pending = pending.then(readToEnd).catch((error: unknown) => {
			if (!closed) ctx.reportError(error);
		});
		return pending;
	};

	// Grok may hold the file open, and a directory watch alone misses such writes on macOS.
	const watch = ctx.watchFile(
		path,
		(change) => {
			if (!closed && change.type === 'change') void read();
		},
		{ heldOpen: true },
	);
	void read();
	return {
		close() {
			closed = true;
			watch.close();
		},
		read,
	};
}
