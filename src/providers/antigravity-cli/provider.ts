import { join } from 'node:path';
import type { ProcessWatchResult } from '../../helpers/types.ts';
import type { Provider, WatchContext } from '../../provider.ts';
import type { SubagentFacts } from '../../types.ts';
import { homeOf, ID, lockOf, summaries, summariesOf } from './data.ts';
import { inspect } from './inspect.ts';
import { timestamp } from './protobuf.ts';
import { facts } from './steps.ts';
import { metadata, storagePath, trajectoryMetadata } from './storage.ts';
import { readStream, type StreamState, streamState } from './stream.ts';
import { subagents } from './subagents.ts';

type Handle = { close(): void };
type Binding = {
	id: string;
	pid: number;
	startTime?: number;
	ino?: number;
	state: StreamState;
	path: string;
	children: Map<string, SubagentFacts>;
	childWatches: Map<string, Handle[]>;
	active: boolean;
	opened: boolean;
	handles: Handle[];
	process?: ProcessWatchResult;
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
				const path = await storagePath(ctx, home, snapshot.id);
				if (path) {
					snapshot.model = (await metadata(ctx, path)).model;
					snapshot.startedAt = timestamp(await trajectoryMetadata(ctx, path), 2);
				}
				yield snapshot;
			}
		},
		subagents: (ctx, id) => subagents(ctx, home, id),
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
				for (const handles of b.childWatches.values()) for (const handle of handles) handle.close();
				if (b.process && b.process !== 'unsupported') b.process.stop();
				if (b.opened && !stopped) ctx.emit('session:close', { id: b.id });
			};
			const read = async (b: Binding, replay: boolean): Promise<void> => {
				const path = b.path;
				const summary = (await summaries(ctx, home, b.id))[0];
				const stat = await ctx.fs.stat(path);
				if (!current(b)) return;
				if (
					!summary ||
					!stat ||
					(await storagePath(ctx, home, b.id)) !== path ||
					(b.ino != null && stat.ino != null && b.ino !== stat.ino)
				) {
					close(b);
					return;
				}
				const result = await readStream(ctx, path, b.state);
				const children = await subagents(ctx, home, b.id);
				const model = result.model;
				if (!b.opened)
					summary.snapshot.startedAt = timestamp(await trajectoryMetadata(ctx, path), 2);

				const info = await ctx.processInfo(b.pid);
				if (!current(b)) return;
				if (
					!info.alive ||
					(b.startTime != null && info.startTime != null && b.startTime !== info.startTime)
				) {
					close(b);
					return;
				}
				b.state = result.state;
				const backgroundWait =
					summary.status === 'idle' && summary.notFullyIdle
						? (result.backgroundWait ??
							(children.some((c) => c.background && c.status === 'running')
								? 'subagent'
								: undefined))
						: undefined;
				const status =
					backgroundWait || (summary.status === 'running' && result.waiting)
						? 'waiting'
						: summary.status;
				const waitingFor = status === 'waiting' ? (backgroundWait ?? result.waitingFor) : undefined;
				if (!b.opened) {
					b.opened = true;
					ctx.emit(known.has(b.id) ? 'session:open' : 'session:create', {
						...summary.snapshot,
						pid: b.pid,
						status,
						waitingFor,
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
				ctx.emit('session:status', {
					id: b.id,
					status,
					waitingFor,
					updatedAt: summary.snapshot.updatedAt,
				});
				const turnFacts = facts(result.events);
				if (replay) ctx.emit('activity:replay', { id: b.id, facts: turnFacts });
				else for (const fact of turnFacts) ctx.emit('turn', { sessionId: b.id, ...fact });
				for (const child of children) {
					if (!current(b)) return;
					const previous = b.children.get(child.id);
					if (!previous) {
						if (replay) ctx.emit('subagent:seed', child);
						else ctx.emit('subagent:start', child);
					}
					if (child.status && child.status !== 'running' && previous?.status !== child.status)
						ctx.emit('subagent:end', {
							sessionId: b.id,
							id: child.id,
							status: child.status,
							endedAt: child.endedAt,
						});
					b.children.set(child.id, child);
					if (!b.childWatches.has(child.id)) {
						const childPath = await storagePath(ctx, home, child.id);
						if (!current(b)) return;
						if (childPath) {
							b.childWatches.set(
								child.id,
								[childPath, `${childPath}-wal`].map((p) =>
									ctx.watchFile(
										p,
										() => {
											void enqueue(() => read(b, false));
										},
										{ heldOpen: true },
									),
								),
							);
							void enqueue(() => read(b, false));
						}
					}
				}
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
				const path = await storagePath(ctx, home, id);
				if (!path || stopped) return;
				const stat = await ctx.fs.stat(path);
				if (!stat || stopped) return;
				b = {
					id,
					...owner,
					ino: stat.ino,
					state: streamState(),
					path,
					children: new Map(),
					childWatches: new Map(),
					active: true,
					opened: false,
					handles: [],
				};
				const binding = b;
				bindings.set(id, binding);
				binding.process = ctx.watchProcess(owner.pid, () => close(binding));
				if (!current(binding)) {
					if (binding.process !== 'unsupported') binding.process.stop();
					return;
				}
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
				if (!/\.(db|pb)$/.test(event.name)) return;
				const id = event.name.slice(0, -3);
				if (ID.test(id)) void enqueue(discover);
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
					if (/\.(db|pb)$/.test(name) && ID.test(name.slice(0, -3))) known.add(name.slice(0, -3));
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
