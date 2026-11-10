import { join } from 'node:path';
import type { ProcessWatchResult } from '../../helpers/types.ts';
import type { Provider, WatchContext } from '../../provider.ts';
import type { SessionEvent } from '../../types.ts';
import {
	databaseOf,
	homeOf,
	ID,
	lockOf,
	STEP_COLUMNS,
	steps,
	summaries,
	summariesOf,
	terminal,
} from './data.ts';
import { freshEvents, inspect } from './inspect.ts';
import { decodeStep, facts } from './steps.ts';

type Handle = { close(): void };
type Binding = {
	id: string;
	pid: number;
	startTime?: number;
	ino?: number;
	cursor: number;
	active: boolean;
	opened: boolean;
	handles: Handle[];
	process?: ProcessWatchResult;
	tools: Set<string>;
};

export function antigravityCli(options: { home?: string } = {}): Provider {
	const home = homeOf(options.home);
	// Each watch context owns its own state, even when a provider is reused by two instances.
	const reconcilers = new WeakMap<WatchContext['emit'], (pid?: number) => Promise<void>>();
	return {
		id: 'antigravity-cli',
		harness: 'AntiGravity',
		async *list(ctx) {
			for (const { snapshot } of await summaries(ctx, home, ctx.id)) {
				if (ctx.since != null && (snapshot.updatedAt == null || snapshot.updatedAt < ctx.since))
					continue;
				yield snapshot;
			}
		},
		inspect: (ctx, id) => inspect(ctx, home, id),
		revalidate: (ctx, pid) => reconcilers.get(ctx.emit)?.(pid),
		async watch(ctx) {
			const sqlite = ctx.sqlite;
			const holdersOf = ctx.processes.holders?.bind(ctx.processes);
			if (!sqlite || !holdersOf) return () => {};
			let stopped = false;
			const bindings = new Map<string, Binding>(),
				known = new Set<string>();
			let release!: () => void;
			let queue = new Promise<void>((resolve) => {
				release = resolve;
			});
			const enqueue = (fn: () => Promise<void>): Promise<void> => {
				queue = queue
					.then(async () => {
						if (!stopped) await fn();
					})
					.catch((error) => {
						if (!stopped) ctx.reportError(error);
					});
				return queue;
			};
			const current = (b: Binding): boolean => !stopped && b.active && bindings.get(b.id) === b;
			const close = (b: Binding): void => {
				if (!b.active) return;
				b.active = false;
				if (bindings.get(b.id) === b) bindings.delete(b.id);
				for (const handle of b.handles) handle.close();
				if (b.process && b.process !== 'unsupported') b.process.stop();
				if (b.opened && !stopped) ctx.emit('session:close', { id: b.id });
			};
			const read = async (b: Binding, replay: boolean): Promise<void> => {
				const path = databaseOf(home, b.id);
				const summary = (await summaries(ctx, home, b.id))[0];
				const stat = await ctx.fs.stat(path);
				if (!current(b)) return;
				if (!summary || !stat || (b.ino != null && stat.ino != null && b.ino !== stat.ino)) {
					close(b);
					return;
				}
				const events: SessionEvent[] = [];
				let cursor = b.cursor;
				const tools = new Set(b.tools);
				let model: string | undefined;
				for await (const row of steps(ctx, path, b.cursor)) {
					if (!current(b)) return;
					const decoded = decodeStep(row);
					if (decoded?.model) model = decoded.model;
					if (!terminal(row.status)) break;
					cursor = Number(row.idx);
					if (decoded) events.push(...freshEvents(decoded.events, tools));
				}
				const latest = (
					await sqlite.query(path, `SELECT ${STEP_COLUMNS} FROM steps ORDER BY idx DESC LIMIT 1`)
				)[0];
				const info = await ctx.processInfo(b.pid);
				if (!current(b)) return;
				if (
					!info.alive ||
					(b.startTime != null && info.startTime != null && b.startTime !== info.startTime)
				) {
					close(b);
					return;
				}
				b.cursor = cursor;
				b.tools = tools;
				const status =
					summary.status === 'running' && latest?.status === 9 && decodeStep(latest)
						? 'waiting'
						: summary.status;
				if (!b.opened) {
					b.opened = true;
					ctx.emit(known.has(b.id) ? 'session:open' : 'session:create', {
						...summary.snapshot,
						pid: b.pid,
						status,
						model,
					});
					known.add(b.id);
				}
				ctx.emit('session:update', {
					id: b.id,
					cwd: summary.snapshot.cwd,
					model,
					updatedAt: summary.snapshot.updatedAt,
				});
				if (summary.snapshot.title)
					ctx.emit('title', { id: b.id, title: summary.snapshot.title, source: 'harness' });
				ctx.emit('session:status', { id: b.id, status, updatedAt: summary.snapshot.updatedAt });
				const turnFacts = facts(events);
				if (replay) ctx.emit('activity:replay', { id: b.id, facts: turnFacts });
				else for (const fact of turnFacts) ctx.emit('turn', { sessionId: b.id, ...fact });
			};
			const refresh = async (id: string): Promise<void> => {
				if (!ID.test(id) || stopped) return;
				let b = bindings.get(id);
				const lock = lockOf(home, id);
				const holders = (await ctx.fs.stat(lock))?.isFile
					? [...new Set(await holdersOf(lock))].filter(
							(pid) => Number.isSafeInteger(pid) && pid > 0,
						)
					: [];
				const alive: { pid: number; startTime?: number }[] = [];
				for (const pid of holders) {
					const info = await ctx.processInfo(pid);
					if (info.alive) alive.push({ pid, startTime: info.startTime });
				}
				if (stopped) return;
				const owner = alive.length === 1 ? alive[0] : undefined;
				if (
					b &&
					(!owner ||
						b.pid !== owner.pid ||
						(b.startTime != null && owner.startTime != null && b.startTime !== owner.startTime))
				) {
					close(b);
					b = undefined;
				}
				if (!owner) return;
				if (b) {
					await read(b, false);
					if (!bindings.has(id)) await refresh(id);
					return;
				}
				if (!(await summaries(ctx, home, id)).length || stopped) return;
				const stat = await ctx.fs.stat(databaseOf(home, id));
				if (!stat || stopped) return;
				b = {
					id,
					...owner,
					ino: stat.ino,
					cursor: -1,
					active: true,
					opened: false,
					handles: [],
					tools: new Set(),
				};
				const binding = b;
				bindings.set(id, binding);
				binding.process = ctx.watchProcess(owner.pid, () => close(binding));
				if (!current(binding)) {
					if (binding.process !== 'unsupported') binding.process.stop();
					return;
				}
				const path = databaseOf(home, id);
				for (const p of [path, `${path}-wal`])
					binding.handles.push(
						ctx.watchFile(
							p,
							() => {
								void enqueue(() => refresh(id));
							},
							{ heldOpen: true },
						),
					);
				try {
					await read(binding, true);
				} catch (error) {
					close(binding);
					throw error;
				}
			};
			const discover = async (): Promise<void> => {
				const names = await ctx.fs.readDir(join(home, 'presence')).catch(() => []);
				const ids = new Set([
					...bindings.keys(),
					...names
						.filter((n) => n.endsWith('.lock'))
						.map((n) => n.slice(0, -5))
						.filter((id) => ID.test(id)),
				]);
				for (const id of ids) await refresh(id);
			};
			const handles: Handle[] = [];
			const presence = ctx.watchDir(join(home, 'presence'), (event) => {
				const id = event.name.replace(/\.lock$/, '');
				if (ID.test(id)) void enqueue(() => refresh(id));
			});
			const conversations = ctx.watchDir(join(home, 'conversations'), (event) => {
				if (!event.name.endsWith('.db')) return;
				const id = event.name.slice(0, -3);
				if (ID.test(id)) void enqueue(() => refresh(id));
			});
			handles.push(presence, conversations);
			for (const p of [summariesOf(home), `${summariesOf(home)}-wal`])
				handles.push(
					ctx.watchFile(
						p,
						() => {
							void enqueue(discover);
						},
						{ heldOpen: true },
					),
				);
			const stop = (): void => {
				stopped = true;
				reconcilers.delete(ctx.emit);
				for (const b of bindings.values()) close(b);
				for (const handle of handles) handle.close();
			};
			try {
				for (const name of await ctx.fs.readDir(join(home, 'conversations')).catch(() => []))
					if (name.endsWith('.db') && ID.test(name.slice(0, -3))) known.add(name.slice(0, -3));
				release();
				await Promise.all([presence.ready, conversations.ready]);
				await enqueue(discover);
				reconcilers.set(ctx.emit, (pid) =>
					enqueue(async () => {
						if (pid == null) await discover();
						else for (const b of [...bindings.values()]) if (b.pid === pid) await refresh(b.id);
					}),
				);
				return stop;
			} catch (error) {
				release();
				stop();
				throw error;
			}
		},
	};
}
