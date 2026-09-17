import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectDir } from '../providers/claude-code/paths.js';
import type { FixtureDriver } from './driver.js';

export function createClaudeFixtureDriver(home: string, start = Date.now() - 200): FixtureDriver {
	const pids = new Map<string, number>();
	const cwds = new Map<string, string>();
	let nextPid = 1000;

	const writeSession = async (id: string, over: Record<string, unknown> = {}): Promise<void> => {
		const pid = pids.get(id) ?? nextPid++;
		pids.set(id, pid);
		const cwd = (over.cwd as string) ?? cwds.get(id) ?? '/tmp/app';
		cwds.set(id, cwd);
		await mkdir(join(home, 'sessions'), { recursive: true });
		await writeFile(
			join(home, 'sessions', `${pid}.json`),
			JSON.stringify({
				pid,
				sessionId: id,
				cwd,
				startedAt: start,
				status: 'busy',
				...over,
			}),
		);
	};

	const appendJournal = async (id: string, records: unknown[]): Promise<void> => {
		const cwd = cwds.get(id) ?? '/tmp/app';
		const dir = join(home, 'projects', encodeProjectDir(cwd));
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.jsonl`);
		const lines = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
		const { appendFile } = await import('node:fs/promises');
		await appendFile(path, lines).catch(async () => {
			await writeFile(path, lines);
		});
	};

	return {
		async createLiveSession(opts) {
			pids.set(opts.id, opts.pid);
			cwds.set(opts.id, opts.cwd ?? '/tmp/app');
			await writeSession(opts.id, {
				status: opts.status ?? 'busy',
				name: opts.title,
				cwd: opts.cwd ?? '/tmp/app',
			});
		},
		async rewriteStatus(id, status) {
			await writeSession(id, { status });
		},
		async switchConversation(pid, newId) {
			pids.set(newId, pid);
			await writeSession(newId, { pid, sessionId: newId });
		},
		async updateMetadata(id, patch) {
			if (patch.cwd) cwds.set(id, patch.cwd);
			await writeSession(id, { cwd: patch.cwd, name: patch.title });
		},
		async remove(id) {
			const pid = pids.get(id);
			if (pid != null) await unlink(join(home, 'sessions', `${pid}.json`)).catch(() => {});
		},
		async addJournal(id, records) {
			await appendJournal(id, records);
		},
		async runTurnWithTool(id) {
			await appendJournal(id, [
				{ type: 'user', sessionId: id, message: { content: 'go' } },
				{
					type: 'assistant',
					sessionId: id,
					message: {
						content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
					},
				},
				{
					type: 'user',
					sessionId: id,
					message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
				},
				{ type: 'system', subtype: 'turn_duration', sessionId: id },
			]);
		},
		async failTurn(id) {
			await appendJournal(id, [
				{ type: 'user', sessionId: id, message: { content: 'go' } },
				{ type: 'assistant', sessionId: id, isApiErrorMessage: true, message: { content: 'api' } },
			]);
		},
		async launchForegroundSubagent(id) {
			await appendJournal(id, [
				{
					type: 'assistant',
					sessionId: id,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'toolu_fg',
								name: 'Agent',
								input: { description: 'look', subagent_type: 'Explore' },
							},
						],
					},
				},
			]);
			return { subagentId: 'toolu_fg' };
		},
		async finishForegroundSubagent(id, subagentId) {
			await appendJournal(id, [
				{
					type: 'user',
					sessionId: id,
					message: {
						content: [{ type: 'tool_result', tool_use_id: subagentId, content: 'done' }],
					},
				},
			]);
		},
		async launchBackgroundSubagent(id) {
			await appendJournal(id, [
				{
					type: 'assistant',
					sessionId: id,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'toolu_bg',
								name: 'Agent',
								input: {
									description: 'bg',
									subagent_type: 'Explore',
									run_in_background: true,
								},
							},
						],
					},
				},
				{
					type: 'user',
					sessionId: id,
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_bg',
								content: 'Async agent launched successfully',
							},
						],
					},
				},
			]);
			return { subagentId: 'toolu_bg' };
		},
		async finishBackgroundSubagent(id, subagentId) {
			await appendJournal(id, [
				{
					type: 'user',
					sessionId: id,
					origin: { kind: 'task-notification' },
					message: {
						content: `<task-notification><tool-use-id>${subagentId}</tool-use-id><status>completed</status></task-notification>`,
					},
				},
			]);
		},
		async launchNestedSubagent(id, parentSubagentId) {
			void parentSubagentId;
			await appendJournal(id, [
				{
					type: 'assistant',
					sessionId: id,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'toolu_nested',
								name: 'Agent',
								input: { description: 'n', subagent_type: 'Explore' },
							},
						],
					},
				},
			]);
			return { subagentId: 'toolu_nested' };
		},
		async relocateJournal(id, newCwd) {
			cwds.set(id, newCwd);
			await writeSession(id, { cwd: newCwd, sessionId: id });
		},
	};
}
