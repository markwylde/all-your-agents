import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { encodeCwd } from '../providers/grok-build/paths.ts';
import type { FixtureDriver } from './driver.ts';

type Entry = { pid: number; cwd: string };

/**
 * Writes Grok Build's files in a temporary home: `active_sessions.json` (rewritten by
 * renaming a temporary sibling over it, as Grok does), session directories with
 * `events.jsonl`, `chat_history.jsonl` and `summary.json`, and `subagents/<id>/meta.json`.
 * Each step waits `settleMs` so the provider has observed it before the next one.
 */
export function createGrokFixtureDriver(
	home: string,
	opts: { settleMs?: number } = {},
): FixtureDriver {
	const settleMs = opts.settleMs ?? 80;
	const entries = new Map<string, Entry>();
	const openTurns = new Set<string>();
	/** Subagent id → the session directory whose `subagents/` holds its meta. */
	const metaHome = new Map<string, string>();
	const childCwds = new Map<string, string>();
	let calls = 0;

	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, settleMs));
	const now = () => new Date().toISOString();

	const atomicWrite = async (path: string, value: unknown): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(`${path}.tmp`, JSON.stringify(value));
		await rename(`${path}.tmp`, path);
	};

	/** Every entry registers again: `opened_at` is when it was last registered. */
	const writeIndex = async (): Promise<void> => {
		const rows = [...entries].map(([id, e]) => ({
			session_id: id,
			pid: e.pid,
			cwd: e.cwd,
			opened_at: now(),
		}));
		await atomicWrite(join(home, 'active_sessions.json'), rows);
		await settle();
	};

	const dirOf = (id: string, cwd = entries.get(id)?.cwd ?? childCwds.get(id) ?? '/tmp/app') =>
		join(home, 'sessions', encodeCwd(cwd), id);

	const append = async (path: string, records: unknown[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
	};

	const events = async (id: string, records: unknown[]): Promise<void> => {
		const ts = now();
		await append(
			join(dirOf(id), 'events.jsonl'),
			records.map((r) => ({ ts, ...(r as object) })),
		);
		await settle();
	};

	const chat = async (id: string, records: unknown[]): Promise<void> => {
		await append(join(dirOf(id), 'chat_history.jsonl'), records);
		await settle();
	};

	const statusRecords = (id: string, status: string): unknown[] => {
		const out: unknown[] = [];
		if (status === 'idle') {
			if (openTurns.delete(id)) out.push({ type: 'turn_ended', outcome: 'completed' });
			return out;
		}
		if (!openTurns.has(id)) {
			openTurns.add(id);
			out.push({ type: 'turn_started', session_id: id, model_id: 'grok-4.6' });
		}
		if (status === 'waiting') {
			out.push(
				{ type: 'phase_changed', phase: 'permission_prompt' },
				{ type: 'permission_requested', tool_name: 'run_terminal_command' },
			);
		} else {
			out.push({ type: 'phase_changed', phase: 'waiting_for_model' });
		}
		return out;
	};

	const spawnCall = (callId: string, description: string, background: boolean) => ({
		type: 'assistant',
		content: '',
		model_id: 'grok-4.6',
		tool_calls: [
			{
				id: callId,
				name: 'spawn_subagent',
				arguments: JSON.stringify({
					description,
					prompt: description,
					subagent_type: 'general-purpose',
					...(background ? { background: true } : {}),
				}),
			},
		],
	});

	const writeMeta = async (
		parentDir: string,
		parentId: string,
		subagentId: string,
		description: string,
		status: string,
	): Promise<void> => {
		const childCwd = childCwds.get(subagentId) ?? '';
		const meta: Record<string, unknown> = {
			subagent_id: subagentId,
			parent_session_id: parentId,
			child_session_id: subagentId,
			subagent_type: 'general-purpose',
			description,
			prompt: description,
			status,
			started_at: now(),
			child_cwd: childCwd,
		};
		if (status !== 'running') meta.completed_at = now();
		await atomicWrite(join(parentDir, 'subagents', subagentId, 'meta.json'), meta);
		if (status === 'completed') {
			await writeFile(
				join(parentDir, 'subagents', subagentId, 'output.json'),
				JSON.stringify({ schema_version: 1, output: 'done' }),
			);
		}
	};

	/** A subagent: its meta under the parent, and its own session directory. */
	const launch = async (
		ownerId: string,
		description: string,
		background: boolean,
	): Promise<string> => {
		const subagentId = randomUUID();
		const callId = `call-${++calls}`;
		const ownerDir = dirOf(ownerId);
		childCwds.set(subagentId, `/tmp/app/.grok/worktrees/${subagentId}`);
		metaHome.set(subagentId, ownerDir);
		const childDir = dirOf(subagentId);
		await mkdir(childDir, { recursive: true });
		await atomicWrite(join(childDir, 'summary.json'), {
			info: { id: subagentId, cwd: childCwds.get(subagentId) },
			session_kind: 'subagent',
		});
		await append(join(childDir, 'chat_history.jsonl'), [
			{ type: 'user', content: [{ type: 'text', text: description }], prompt_index: 0 },
		]);
		const records: unknown[] = [spawnCall(callId, description, background)];
		if (background) {
			records.push({
				type: 'tool_result',
				tool_call_id: callId,
				content: `Subagent started in background.\nsubagent_id: ${subagentId}\ntype: general-purpose\ndescription: ${description}`,
			});
		}
		await append(join(ownerDir, 'chat_history.jsonl'), records);
		await writeMeta(ownerDir, ownerId, subagentId, description, 'running');
		await settle();
		return subagentId;
	};

	const finish = async (subagentId: string, parentId: string): Promise<void> => {
		const parentDir = metaHome.get(subagentId);
		if (!parentDir) return;
		await writeMeta(parentDir, parentId, subagentId, 'done', 'completed');
		await settle();
	};

	return {
		async createLiveSession(o) {
			entries.set(o.id, { pid: o.pid, cwd: o.cwd ?? '/tmp/app' });
			await writeIndex();
			if (o.title) {
				await atomicWrite(join(dirOf(o.id), 'summary.json'), {
					info: { id: o.id, cwd: o.cwd ?? '/tmp/app' },
					generated_title: o.title,
				});
			}
			await events(o.id, statusRecords(o.id, o.status ?? 'busy'));
		},
		async rewriteStatus(id, status) {
			const records = statusRecords(id, status);
			if (records.length) await events(id, records);
		},
		async switchConversation(pid, newId) {
			let cwd = '/tmp/app';
			for (const [id, e] of [...entries]) {
				if (e.pid !== pid) continue;
				cwd = e.cwd;
				entries.delete(id);
			}
			entries.set(newId, { pid, cwd });
			await writeIndex();
		},
		async updateMetadata(id, patch) {
			const e = entries.get(id);
			if (e && patch.cwd) {
				e.cwd = patch.cwd;
				await writeIndex();
			}
			if (patch.title) {
				await atomicWrite(join(dirOf(id), 'summary.json'), {
					info: { id, cwd: e?.cwd },
					generated_title: patch.title,
					title_is_manual: true,
				});
				await settle();
			}
		},
		async remove(id) {
			entries.delete(id);
			openTurns.delete(id);
			await writeIndex();
		},
		async addJournal(id, records) {
			await chat(id, records);
		},
		async runTurnWithTool(id) {
			await chat(id, [
				{ type: 'user', content: [{ type: 'text', text: 'go' }], prompt_index: 0 },
				{
					type: 'assistant',
					content: '',
					model_id: 'grok-4.6',
					tool_calls: [{ id: 't1', name: 'run_terminal_command', arguments: '{"command":"ls"}' }],
				},
				{ type: 'tool_result', tool_call_id: 't1', content: 'ok' },
			]);
			const start = openTurns.has(id) ? [] : [{ type: 'turn_started', model_id: 'grok-4.6' }];
			openTurns.delete(id);
			await events(id, [
				...start,
				{ type: 'phase_changed', phase: 'tool_execution' },
				{ type: 'tool_started', tool_name: 'run_terminal_command' },
				{
					type: 'tool_completed',
					tool_name: 'run_terminal_command',
					tool_call_id: 't1',
					outcome: 'success',
				},
				{ type: 'turn_ended', outcome: 'completed' },
			]);
		},
		async failTurn(id) {
			openTurns.delete(id);
			await events(id, [
				{ type: 'turn_started', model_id: 'grok-4.6' },
				{ type: 'phase_changed', phase: 'waiting_for_model' },
				{ type: 'turn_ended', outcome: 'error' },
			]);
		},
		async launchForegroundSubagent(id) {
			return { subagentId: await launch(id, 'look', false) };
		},
		async finishForegroundSubagent(id, subagentId) {
			await finish(subagentId, id);
		},
		async launchBackgroundSubagent(id) {
			return { subagentId: await launch(id, 'bg', true) };
		},
		async finishBackgroundSubagent(id, subagentId) {
			await finish(subagentId, id);
		},
		async launchNestedSubagent(_id, parentSubagentId) {
			return { subagentId: await launch(parentSubagentId, 'nested', false) };
		},
		async relocateJournal(id, newCwd) {
			const e = entries.get(id);
			if (!e) return;
			const from = dirOf(id);
			const to = dirOf(id, newCwd);
			if (await stat(from).catch(() => null)) {
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
			}
			e.cwd = newCwd;
			await writeIndex();
		},
	};
}
