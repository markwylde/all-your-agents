import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Processes } from '../helpers/types.ts';
import type { FixtureDriver } from './driver.ts';

type Live = { pid: number; cwd: string; path: string; terminal: string; presence: string };

type OmpProcesses = Processes & {
	set(pid: number, alive: boolean, startTime?: number): void;
	exit(pid: number): void;
	setTty(pid: number, tty: string | undefined): void;
};

/**
 * Writes what a real omp writes: a presence file per process, a breadcrumb per terminal,
 * a transcript with the fixed-width title slot and `session` header, `stopReason`-driven
 * turns, `tool_execution_start` markers, and child transcripts in the artifact directory.
 */
export function createOmpFixtureDriver(
	home: string,
	opts: { settleMs?: number } = {},
): FixtureDriver & {
	processes: OmpProcesses;
	pathOf(id: string, cwd?: string): string;
	/** A launch before any transcript exists: presence plus a `fresh` breadcrumb. */
	launchFresh(o: { id: string; pid: number; cwd?: string }): Promise<void>;
} {
	const settleMs = opts.settleMs ?? 80;
	const entries = new Map<string, Live>();
	const openTurns = new Set<string>();
	const start = Date.now() - 1000;
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, () => void>();
	const ttys = new Map<number, string | undefined>();

	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, settleMs));
	const now = () => new Date().toISOString();
	const entryId = () => randomBytes(4).toString('hex');
	const stamp = '2026-01-01T00-00-00-000Z';

	const encode = (cwd: string) => `-${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}-`;
	const pathOf = (id: string, cwd = '/tmp/app') =>
		join(home, 'agent', 'sessions', encode(cwd), `${stamp}_${id}.jsonl`);
	const artifacts = (path: string) => path.slice(0, -'.jsonl'.length);
	const terminalOf = (pid: number) => `ttys${String(pid).padStart(3, '0')}`;

	const processes: OmpProcesses = {
		async info(pid) {
			return alive.get(pid) ?? { alive: true, startTime: start };
		},
		watch(pid, onExit) {
			exits.set(pid, onExit);
			return {
				stop() {
					exits.delete(pid);
				},
			};
		},
		async tty(pid) {
			return ttys.has(pid) ? ttys.get(pid) : terminalOf(pid);
		},
		set(pid, a, t = start) {
			alive.set(pid, { alive: a, startTime: t });
		},
		exit(pid) {
			alive.set(pid, { alive: false, startTime: start });
			exits.get(pid)?.();
		},
		setTty(pid, tty) {
			ttys.set(pid, tty);
		},
	};

	const slot = (title = '') => {
		const body = { type: 'title', v: 1, title, source: 'auto', updatedAt: now(), pad: '' };
		const width = 255;
		const bare = JSON.stringify(body);
		body.pad = ' '.repeat(Math.max(0, width - bare.length));
		return body;
	};
	const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
		type: 'session',
		version: 3,
		id,
		timestamp: now(),
		cwd,
		...extra,
	});
	const entry = (type: string, body: Record<string, unknown>) => ({
		type,
		id: entryId(),
		parentId: null,
		timestamp: now(),
		...body,
	});
	const user = (text: string) =>
		entry('message', { message: { role: 'user', content: [{ type: 'text', text }] } });
	const assistant = (stopReason: string, content: unknown[], extra: Record<string, unknown> = {}) =>
		entry('message', {
			message: {
				role: 'assistant',
				content,
				provider: 'xai-oauth',
				model: 'grok-4.6',
				stopReason,
				...extra,
			},
		});
	const toolCall = (id: string, name: string) => ({ type: 'toolCall', id, name, arguments: '{}' });
	const marker = (toolCallId: string, toolName: string) =>
		entry('custom', {
			customType: 'tool_execution_start',
			data: { toolCallId, toolName, startedAt: now() },
		});
	const toolResult = (toolCallId: string, toolName: string, details: unknown = {}) =>
		entry('message', {
			message: {
				role: 'toolResult',
				toolCallId,
				toolName,
				content: [{ type: 'text', text: 'ok' }],
				details,
				isError: false,
			},
		});

	const lines = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
	const append = async (path: string, records: unknown[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, lines(records));
	};
	const writeLines = async (path: string, records: unknown[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, lines(records));
	};

	const writeBreadcrumb = async (e: Live, fresh: boolean): Promise<void> => {
		const dir = join(home, 'agent', 'terminal-sessions');
		await mkdir(dir, { recursive: true });
		const extras = fresh ? 'fresh\n' : '';
		await writeFile(join(dir, e.terminal), `${e.cwd}\n${e.path}\n${extras}cwdstat 1 1\n`);
	};

	const register = async (id: string, pid: number, cwd: string): Promise<Live> => {
		if (!alive.has(pid)) alive.set(pid, { alive: true, startTime: start });
		const clients = join(home, 'run', 'daemons', 'a1b2c3d4e5f60718', 'clients');
		const live: Live = {
			pid,
			cwd,
			path: pathOf(id, cwd),
			terminal: (await processes.tty?.(pid))?.replace(/\//g, '-') ?? terminalOf(pid),
			presence: join(clients, `${pid}-${id}.json`),
		};
		entries.set(id, live);
		await mkdir(clients, { recursive: true });
		await writeFile(live.presence, JSON.stringify({ pid, id: `${pid}-${id}`, projectDir: cwd }));
		return live;
	};

	const spawnChild = async (id: string, name: string, parentPath?: string) => {
		const parent = entries.get(id);
		if (!parent) return { subagentId: name };
		const path = join(artifacts(parent.path), `${name}.jsonl`);
		await writeLines(path, [
			slot(),
			header(`00000000-0000-4000-9000-${randomBytes(6).toString('hex')}`, parent.cwd, {
				parentSession: parentPath ?? parent.path,
			}),
			entry('model_change', { model: 'xai-oauth/grok-4.6' }),
			entry('session_init', { agent: 'scout', task: 'do the thing', tools: ['read'] }),
			user('do the thing'),
		]);
		await settle();
		return { subagentId: name };
	};

	const finishChild = async (id: string, name: string): Promise<void> => {
		const parent = entries.get(id);
		if (!parent) return;
		await append(join(artifacts(parent.path), `${name}.jsonl`), [
			assistant('toolUse', [toolCall(`y-${name}`, 'yield')]),
			marker(`y-${name}`, 'yield'),
			toolResult(`y-${name}`, 'yield', { data: { result: 1 }, status: 'success' }),
		]);
		await settle();
	};

	return {
		processes,
		pathOf,
		async launchFresh(o) {
			const live = await register(o.id, o.pid, o.cwd ?? '/tmp/app');
			await writeBreadcrumb(live, true);
			await settle();
		},
		async createLiveSession(o) {
			const cwd = o.cwd ?? '/tmp/app';
			const path = pathOf(o.id, cwd);
			const records: unknown[] = [slot(o.title), header(o.id, cwd)];
			records.push(entry('model_change', { model: 'xai-oauth/grok-4.6' }));
			if (o.title) records.push(entry('title_change', { title: o.title, source: 'auto' }));
			if ((o.status ?? 'busy') === 'busy') {
				records.push(user('hello'));
				openTurns.add(o.id);
			}
			await writeLines(path, records);
			const live = await register(o.id, o.pid, cwd);
			await writeBreadcrumb(live, false);
			await settle();
		},
		async rewriteStatus(id, status) {
			const e = entries.get(id);
			if (!e) return;
			if (status === 'busy' || status === 'running') {
				if (!openTurns.has(id)) {
					openTurns.add(id);
					await append(e.path, [user('again')]);
				}
			} else if (status === 'idle' && openTurns.delete(id)) {
				await append(e.path, [assistant('stop', [{ type: 'text', text: 'done' }])]);
			}
			await settle();
		},
		async switchConversation(pid, newId) {
			let old: Live | undefined;
			for (const [id, e] of [...entries]) {
				if (e.pid !== pid) continue;
				old = e;
				entries.delete(id);
				openTurns.delete(id);
			}
			if (!old) return;
			// `/new`: same process, same presence file, the breadcrumb names a fresh session.
			const live: Live = { ...old, path: pathOf(newId, old.cwd) };
			entries.set(newId, live);
			await writeBreadcrumb(live, true);
			await settle();
		},
		async updateMetadata(id, patch) {
			const e = entries.get(id);
			if (!e) return;
			if (patch.title) {
				await append(e.path, [entry('title_change', { title: patch.title, source: 'auto' })]);
			}
			if (patch.cwd) await this.relocateJournal(id, patch.cwd);
			await settle();
		},
		async remove(id) {
			const e = entries.get(id);
			if (!e) return;
			entries.delete(id);
			openTurns.delete(id);
			// A clean exit: the exit marker, then the presence file goes.
			await append(e.path, [
				entry('custom', {
					customType: 'session_exit',
					data: { reason: 'dispose', kind: 'normal' },
				}),
			]);
			await rm(e.presence, { force: true });
			await settle();
		},
		async addJournal(id, records) {
			const e = entries.get(id);
			if (!e) return;
			await append(e.path, records);
			await settle();
		},
		async runTurnWithTool(id) {
			const e = entries.get(id);
			if (!e) return;
			const records: unknown[] = [];
			if (!openTurns.has(id)) records.push(user('run it'));
			records.push(
				assistant('toolUse', [{ type: 'text', text: 'running' }, toolCall('t1', 'bash')]),
				marker('t1', 'bash'),
				toolResult('t1', 'bash'),
				assistant('stop', [{ type: 'text', text: 'done' }]),
			);
			openTurns.delete(id);
			await append(e.path, records);
			await settle();
		},
		async failTurn(id) {
			const e = entries.get(id);
			if (!e) return;
			const records: unknown[] = [];
			if (!openTurns.has(id)) records.push(user('break it'));
			records.push(assistant('error', [], { errorMessage: 'failed' }));
			openTurns.delete(id);
			await append(e.path, records);
			await settle();
		},
		launchForegroundSubagent: (id) => spawnChild(id, 'ScoutCode'),
		finishForegroundSubagent: (id, subagentId) => finishChild(id, subagentId),
		launchBackgroundSubagent: (id) => spawnChild(id, 'PowTwoTen'),
		finishBackgroundSubagent: (id, subagentId) => finishChild(id, subagentId),
		async launchNestedSubagent(id, parentSubagentId) {
			const parent = entries.get(id);
			const parentPath = parent
				? join(artifacts(parent.path), `${parentSubagentId}.jsonl`)
				: undefined;
			return spawnChild(id, 'NestedEuler', parentPath);
		},
		async relocateJournal(id, newCwd) {
			const e = entries.get(id);
			if (!e) return;
			const dest = join(home, 'agent', 'sessions', encode(newCwd), basename(e.path));
			const text = await readFile(e.path, 'utf8');
			const rows = text.split('\n').filter(Boolean);
			const moved = rows.map((row) => {
				const rec = JSON.parse(row) as Record<string, unknown>;
				return rec.type === 'session' ? JSON.stringify({ ...rec, cwd: newCwd }) : row;
			});
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, `${moved.join('\n')}\n`);
			await rename(artifacts(e.path), artifacts(dest)).catch(() => {});
			await rm(e.path, { force: true });
			e.path = dest;
			e.cwd = newCwd;
			await writeBreadcrumb(e, false);
			await settle();
		},
	};
}
