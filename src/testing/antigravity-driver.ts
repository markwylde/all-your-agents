import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, open, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Processes, SqliteRow } from '../helpers/types.ts';
import type { FixtureDriver } from './driver.ts';

/** Protobuf varint, as agy writes them. */
export function varint(value: number): number[] {
	const bytes: number[] = [];
	do {
		const byte = value % 128;
		value = Math.floor(value / 128);
		bytes.push(byte | (value ? 128 : 0));
	} while (value);
	return bytes;
}

/** A protobuf message of varint and length-delimited fields, in the order given. */
export function proto(...entries: [number, number | string | Uint8Array][]): Uint8Array {
	return new Uint8Array(
		entries.flatMap(([key, value]) => {
			if (typeof value === 'number') return [...varint(key * 8), ...varint(value)];
			const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
			return [...varint(key * 8 + 2), ...varint(bytes.length), ...bytes];
		}),
	);
}

/** One `steps` row: a CortexStep with its type, status, step metadata and payload field. */
export function row(
	idx: number,
	type: number,
	payloadKey: number,
	body: Uint8Array,
	status = 3,
	metadata?: Uint8Array,
): SqliteRow {
	return {
		idx,
		step_type: type,
		status,
		step_format: 0,
		step_payload: proto(
			[1, type],
			[4, status],
			[5, metadata ?? proto([1, proto([1, 1800000000 + idx])], [8, proto([1, 1800000001 + idx])])],
			[payloadKey, body],
		),
	};
}

type AntigravityProcesses = Processes & {
	set(pid: number, alive: boolean, startTime?: number): void;
	/** The process ends: it no longer holds its locks and its exit watch fires. */
	exit(pid: number): void;
};

/** A real process holding a conversation's presence lock open. */
export type AntigravityHolder = { pid: number; startedAt: number; stop(): Promise<void> };

type Step = {
	type: number;
	key: number;
	body: Uint8Array;
	status: number;
	/** The tool call this step runs, in its step metadata. */
	tool?: Uint8Array;
	/** A background task, written alongside the payload. */
	task?: Uint8Array;
	/** A whole CortexStep payload passed through `addJournal`. */
	raw?: Uint8Array;
};
type Conversation = {
	id: string;
	cwd: string;
	title?: string;
	status: string;
	parent?: string;
	killed?: boolean;
	notFullyIdle?: boolean;
	steps: Step[];
	openTurn: boolean;
	background: number[];
};

type Database = { exec(sql: string): void; close(): void };
type SqliteModule = { DatabaseSync: new (path: string) => Database };
/** Kept out of the import graph so the testing entry still loads on a Node without SQLite. */
const BUILT_IN = 'node:sqlite';
let sqliteModule: Promise<SqliteModule> | undefined;
const loadSqlite = (): Promise<SqliteModule> => {
	sqliteModule ??= (async () => {
		const emit = process.emitWarning;
		process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
			const text = typeof warning === 'string' ? warning : warning?.message;
			if (text?.includes('SQLite')) return;
			(emit as (...args: unknown[]) => void).call(process, warning, ...rest);
		}) as typeof process.emitWarning;
		try {
			return (await import(BUILT_IN)) as SqliteModule;
		} catch (error) {
			throw new Error('createAntigravityFixtureDriver needs a Node with built-in node:sqlite', {
				cause: error,
			});
		} finally {
			process.emitWarning = emit;
		}
	})();
	return sqliteModule;
};

const quote = (value: string | undefined): string =>
	value == null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
const blob = (bytes: Uint8Array): string => `X'${Buffer.from(bytes).toString('hex')}'`;
const RUN_STATUS = (status: string): string =>
	status === 'busy' || status === 'running'
		? 'CASCADE_RUN_STATUS_RUNNING'
		: 'CASCADE_RUN_STATUS_IDLE';
const SUMMARIES = `CREATE TABLE IF NOT EXISTS conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT, last_modified_time TEXT, killed INTEGER, not_fully_idle INTEGER);`;
const CONVERSATION = `CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB); CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS executor_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB);`;

/**
 * Writes what a real agy 1.5.5 writes under `~/.gemini/antigravity-cli`: a
 * `conversation_summaries.db` row per conversation, a `conversations/<uuid>.db` of
 * protobuf steps, and a `presence/<uuid>.lock` that the live process holds open.
 *
 * The provider binds a conversation to the one live process holding its lock. Unit tests
 * pass `driver.processes`, which reports the `pid` given to `createLiveSession` as that
 * holder. Against the real process probe, the pid must actually hold the lock: start it
 * with `spawnHolder(id)`, or open `await prepareLock(id)` from your own process (for
 * example `sh -c 'exec 3>>"$0"; exec sleep 600' <lock>` in a terminal) before calling
 * `createLiveSession`. Calling `createLiveSession` again for a stored id with another pid
 * resumes that conversation; after `remove`, it stays listed as history.
 *
 * Needs Node's built-in `node:sqlite`. Each step waits `settleMs`, when given.
 */
export function createAntigravityFixtureDriver(
	home: string,
	opts: { settleMs?: number } = {},
): FixtureDriver & {
	processes: AntigravityProcesses;
	/** Creates the presence directory and the empty lock file, and returns the lock's path. */
	prepareLock(id: string): Promise<string>;
	/** Starts a real process holding the conversation's lock open. */
	spawnHolder(id: string): Promise<AntigravityHolder>;
	/** Stops every holder `spawnHolder` started. */
	dispose(): Promise<void>;
} {
	const settle = async (): Promise<void> => {
		if (opts.settleMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.settleMs));
	};
	const start = Date.now() - 1000;
	const conversations = new Map<string, Conversation>();
	const holders = new Map<string, number>();
	const spawned = new Map<string, ChildProcess>();
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, Set<() => void>>();
	const presence = join(home, 'presence');
	const lockOf = (id: string) => join(presence, `${id}.lock`);
	const databaseOf = (id: string) => join(home, 'conversations', `${id}.db`);
	const summaries = join(home, 'conversation_summaries.db');

	const processes: AntigravityProcesses = {
		async info(pid) {
			return alive.get(pid) ?? { alive: true, startTime: start };
		},
		watch(pid, onExit) {
			const set = exits.get(pid) ?? new Set();
			set.add(onExit);
			exits.set(pid, set);
			return {
				stop() {
					exits.get(pid)?.delete(onExit);
				},
			};
		},
		async holders(path) {
			const id = /([^/\\]+)\.lock$/.exec(path)?.[1];
			const pid = id ? holders.get(id) : undefined;
			return pid != null && alive.get(pid)?.alive !== false ? [pid] : [];
		},
		set(pid, a, t = start) {
			alive.set(pid, { alive: a, startTime: t });
		},
		exit(pid) {
			alive.set(pid, { alive: false, startTime: start });
			for (const [id, holder] of holders) if (holder === pid) holders.delete(id);
			for (const onExit of [...(exits.get(pid) ?? [])]) onExit();
		},
	};

	const write = async (path: string, sql: string): Promise<void> => {
		const { DatabaseSync } = await loadSqlite();
		await mkdir(join(home, 'conversations'), { recursive: true });
		const db = new DatabaseSync(path);
		try {
			db.exec(sql);
		} finally {
			db.close();
		}
	};

	const now = () => Math.floor(Date.now() / 1000);
	const stamp = (seconds = now()) => proto([1, seconds]);
	const encode = (c: Conversation, idx: number): SqliteRow => {
		const step = c.steps[idx] as Step;
		if (step.raw) return { idx, step_type: step.type, status: step.status, step_payload: step.raw };
		const meta = proto(
			[1, stamp()],
			[8, stamp()],
			...(step.tool ? ([[4, step.tool]] as [number, Uint8Array][]) : []),
			...(step.type === 15
				? ([[24, proto([20, 'gemini-fixture'])]] as [number, Uint8Array][])
				: []),
		);
		const out = row(idx, step.type, step.key, step.body, step.status, meta);
		if (!step.task) return out;
		const payload = out.step_payload as Uint8Array;
		const task = proto([148, step.task]);
		const joined = new Uint8Array(payload.length + task.length);
		joined.set(payload);
		joined.set(task, payload.length);
		return { ...out, step_payload: joined };
	};
	const insert = (c: Conversation, idx: number): string => {
		const r = encode(c, idx);
		return `INSERT OR REPLACE INTO steps VALUES(${r.idx}, ${r.step_type}, ${r.status}, 0, ${blob(r.step_payload as Uint8Array)});`;
	};
	const append = async (c: Conversation, steps: Step[]): Promise<number[]> => {
		const indices = steps.map((step) => c.steps.push(step) - 1);
		await write(databaseOf(c.id), indices.map((i) => insert(c, i)).join(' '));
		return indices;
	};
	const summarise = async (c: Conversation): Promise<void> => {
		const modified = new Date().toISOString().replace('T', ' ').replace('Z', '+00:00');
		await write(
			summaries,
			`${SUMMARIES} INSERT OR REPLACE INTO conversation_summaries VALUES(${quote(c.id)}, ${quote(c.title)}, ${quote(JSON.stringify([pathToFileURL(c.cwd).href]))}, ${quote(RUN_STATUS(c.status))}, ${quote(c.parent ?? '')}, ${quote(modified)}, ${c.killed ? 1 : 0}, ${c.notFullyIdle ? 1 : 0});`,
		);
	};
	const create = async (
		c: Conversation,
		trajectory: Uint8Array = proto([2, stamp()]),
	): Promise<void> => {
		await write(
			databaseOf(c.id),
			`${CONVERSATION} INSERT OR REPLACE INTO trajectory_metadata_blob VALUES('main', ${blob(trajectory)});`,
		);
	};

	const user = (text = 'Hello fixture'): Step => ({
		type: 14,
		key: 19,
		body: proto([2, text]),
		status: 3,
	});
	const reply = (text = 'Fixture reply', calls: Uint8Array[] = []): Step => ({
		type: 15,
		key: 20,
		body: proto(
			[1, text],
			...calls.map((call): [number, Uint8Array] => [7, call]),
			...(calls.length ? [] : ([[12, 2]] as [number, number][])),
		),
		status: 3,
	});
	const command = (id: string, status = 3): Step => ({
		type: 132,
		key: 140,
		body: proto(),
		status,
		tool: proto([1, id], [2, 'run_command']),
	});

	const get = (id: string): Conversation => {
		const c = conversations.get(id);
		if (!c) throw new Error(`No fixture conversation ${id}`);
		return c;
	};
	const beginTurn = async (c: Conversation): Promise<void> => {
		if (c.openTurn) return;
		c.openTurn = true;
		await append(c, [user()]);
	};
	const endTurn = async (c: Conversation, steps: Step[] = [reply()]): Promise<void> => {
		c.openTurn = false;
		await append(c, steps);
	};

	const prepareLock = async (id: string): Promise<string> => {
		await mkdir(presence, { recursive: true });
		await appendFile(lockOf(id), '');
		return lockOf(id);
	};
	/** Touch the lock, so the provider looks at who holds it now. */
	const touchLock = async (id: string): Promise<void> => {
		await prepareLock(id);
		const at = new Date();
		await utimes(lockOf(id), at, at);
	};
	const release = async (id: string): Promise<void> => {
		holders.delete(id);
		const child = spawned.get(id);
		spawned.delete(id);
		if (child && child.exitCode == null && child.signalCode == null) {
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			await exited;
		}
		await unlink(lockOf(id)).catch(() => {});
	};

	const subagent = async (
		id: string,
		parent: string,
		background: boolean,
	): Promise<{ subagentId: string }> => {
		const root = get(id);
		const child: Conversation = {
			id: randomUUID(),
			cwd: root.cwd,
			title: background ? 'Background fixture task' : 'Fixture task',
			status: 'busy',
			parent,
			steps: [],
			openTurn: true,
			background: [],
		};
		conversations.set(child.id, child);
		await create(
			child,
			proto(
				[2, stamp()],
				[5, parent],
				[6, id],
				[8, proto([1, 'general'], [2, child.title as string], [9, background ? 1 : 0])],
			),
		);
		await append(child, [user('Fixture task')]);
		await summarise(child);
		await settle();
		return { subagentId: child.id };
	};
	const finish = async (subagentId: string): Promise<void> => {
		const child = get(subagentId);
		await endTurn(child);
		child.status = 'idle';
		await summarise(child);
		await settle();
	};

	const createLiveSession: FixtureDriver['createLiveSession'] = async (o) => {
		let c = conversations.get(o.id);
		const status = o.status ?? 'busy';
		if (!c) {
			c = {
				id: o.id,
				cwd: o.cwd ?? '/tmp/app',
				title: o.title,
				status,
				steps: [],
				openTurn: false,
				background: [],
			};
			conversations.set(o.id, c);
			await create(c);
			await beginTurn(c);
			if (status !== 'busy' && status !== 'running') await endTurn(c);
		} else {
			if (o.cwd) c.cwd = o.cwd;
			if (o.title) c.title = o.title;
			c.status = status;
			if (status === 'busy' || status === 'running') await beginTurn(c);
		}
		alive.set(o.pid, { alive: true, startTime: start });
		holders.set(o.id, o.pid);
		await summarise(c);
		await touchLock(o.id);
		await settle();
	};

	return {
		processes,
		prepareLock,
		async spawnHolder(id) {
			const path = await prepareLock(id);
			const handle = await open(path, 'a');
			let child: ChildProcess;
			try {
				child = spawn('sleep', ['86400'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
				await once(child, 'spawn');
			} finally {
				await handle.close();
			}
			const pid = child.pid as number;
			spawned.set(id, child);
			return {
				pid,
				startedAt: Date.now(),
				async stop() {
					if (child.exitCode != null || child.signalCode != null) return;
					const exited = once(child, 'exit');
					child.kill('SIGTERM');
					await exited;
				},
			};
		},
		async dispose() {
			await Promise.all(
				[...spawned.values()].map(async (child) => {
					if (child.exitCode != null || child.signalCode != null) return;
					const exited = once(child, 'exit');
					child.kill('SIGTERM');
					await exited;
				}),
			);
			spawned.clear();
		},
		createLiveSession,
		async rewriteStatus(id, status) {
			const c = get(id);
			if (status === 'busy' || status === 'running') await beginTurn(c);
			else if (c.openTurn) await endTurn(c);
			c.status = status;
			await summarise(c);
			await settle();
		},
		async startBackgroundWait(id) {
			const c = get(id);
			const call = `background-${c.steps.length}`;
			const step = command(call, 2);
			step.task = proto([1, call], [8, stamp()]);
			const [idx] = await append(c, [step]);
			c.background.push(idx as number);
			await endTurn(c);
			c.status = 'idle';
			c.notFullyIdle = true;
			await summarise(c);
			await settle();
		},
		async endBackgroundWait(id) {
			const c = get(id);
			const sql = c.background.map((idx) => {
				(c.steps[idx] as Step).status = 3;
				return insert(c, idx);
			});
			c.background = [];
			if (sql.length) await write(databaseOf(id), sql.join(' '));
			c.notFullyIdle = false;
			await summarise(c);
			await settle();
		},
		async switchConversation(pid, newId) {
			let cwd = '/tmp/app';
			for (const [id, holder] of [...holders]) {
				if (holder !== pid) continue;
				cwd = conversations.get(id)?.cwd ?? cwd;
				holders.delete(id);
				await unlink(lockOf(id)).catch(() => {});
			}
			await settle();
			await createLiveSession({ id: newId, pid, cwd, status: 'idle' });
		},
		async updateMetadata(id, patch) {
			const c = get(id);
			if (patch.cwd) c.cwd = patch.cwd;
			if (patch.title) c.title = patch.title;
			await summarise(c);
			await settle();
		},
		async remove(id) {
			await release(id);
			const c = conversations.get(id);
			if (c) {
				// Its children stop with it: agy marks them killed.
				for (const child of conversations.values())
					if (child.parent && child.status !== 'idle' && root(child) === id) {
						child.killed = true;
						child.status = 'idle';
						await summarise(child);
					}
			}
			await settle();
		},
		async addJournal(id, records) {
			const c = get(id);
			const steps = records.map((r): Step => {
				const step = r as SqliteRow;
				if (!(step.step_payload instanceof Uint8Array))
					throw new Error('addJournal takes steps rows with a step_payload');
				return {
					type: Number(step.step_type),
					key: 0,
					body: proto(),
					status: Number(step.status),
					raw: step.step_payload,
				};
			});
			await append(c, steps);
			await settle();
		},
		async runTurnWithTool(id) {
			const c = get(id);
			await beginTurn(c);
			const call = `call-${c.steps.length}`;
			await append(c, [reply('Running a command', [proto([1, call], [2, 'run_command'])])]);
			await append(c, [command(call)]);
			await endTurn(c);
			c.status = 'idle';
			await summarise(c);
			await settle();
		},
		async failTurn(id) {
			const c = get(id);
			await beginTurn(c);
			const failed = reply('Fixture failure');
			failed.status = 7;
			failed.body = proto([1, 'Fixture failure'], [12, 13]);
			c.openTurn = false;
			await append(c, [failed]);
			c.status = 'idle';
			await summarise(c);
			await settle();
		},
		launchForegroundSubagent: (id) => subagent(id, id, false),
		finishForegroundSubagent: (_id, subagentId) => finish(subagentId),
		launchBackgroundSubagent: (id) => subagent(id, id, true),
		finishBackgroundSubagent: (_id, subagentId) => finish(subagentId),
		launchNestedSubagent: (id, parentSubagentId) => subagent(id, parentSubagentId, false),
		async relocateJournal(id, newCwd) {
			const c = get(id);
			c.cwd = newCwd;
			await summarise(c);
			await settle();
		},
	};

	function root(c: Conversation): string {
		let at = c;
		const seen = new Set<string>();
		while (at.parent && !seen.has(at.id)) {
			seen.add(at.id);
			const next = conversations.get(at.parent);
			if (!next) return at.parent;
			at = next;
		}
		return at.id;
	}
}
