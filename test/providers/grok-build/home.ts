import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeCwd } from '../../../src/providers/grok-build/paths.js';

export { fakeProcesses } from '../claude-code/home.js';

/** Builders for a temporary Grok home: the live index, session directories, journals. */

export type Entry = { session_id: string; pid: number; cwd: string; opened_at: string };

export function entry(id: string, pid: number, cwd = '/tmp/app', openedAt = Date.now()): Entry {
	return { session_id: id, pid, cwd, opened_at: new Date(openedAt).toISOString() };
}

/** Rewrites the index the way Grok does: a temporary sibling renamed over it. */
export async function writeIndex(home: string, entries: unknown): Promise<void> {
	await mkdir(home, { recursive: true });
	const tmp = join(home, 'active_sessions.json.tmp');
	await writeFile(tmp, JSON.stringify(entries));
	await rename(tmp, join(home, 'active_sessions.json'));
}

export function sessionDir(home: string, cwd: string, id: string): string {
	return join(home, 'sessions', encodeCwd(cwd), id);
}

export async function makeSession(
	home: string,
	cwd: string,
	id: string,
	files: {
		summary?: Record<string, unknown>;
		events?: unknown[];
		chat?: unknown[];
		updates?: unknown[];
	} = {},
): Promise<string> {
	const dir = sessionDir(home, cwd, id);
	await mkdir(dir, { recursive: true });
	if (files.summary) {
		await writeFile(
			join(dir, 'summary.json'),
			JSON.stringify({ info: { id, cwd }, ...files.summary }),
		);
	}
	if (files.events) await appendLines(join(dir, 'events.jsonl'), files.events);
	if (files.chat) await appendLines(join(dir, 'chat_history.jsonl'), files.chat);
	if (files.updates) await appendLines(join(dir, 'updates.jsonl'), files.updates);
	return dir;
}

export async function appendLines(path: string, records: unknown[]): Promise<void> {
	await appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

export async function writeMeta(
	dir: string,
	meta: Record<string, unknown>,
	output?: unknown,
): Promise<void> {
	const metaDir = join(dir, 'subagents', String(meta.subagent_id));
	await mkdir(metaDir, { recursive: true });
	await writeFile(join(metaDir, 'meta.json.tmp'), JSON.stringify(meta));
	await rename(join(metaDir, 'meta.json.tmp'), join(metaDir, 'meta.json'));
	if (output !== undefined) await writeFile(join(metaDir, 'output.json'), JSON.stringify(output));
}

export const ts = (ms: number): string => new Date(ms).toISOString();

export const user = (text: string, promptIndex: number) => ({
	type: 'user',
	content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
	prompt_index: promptIndex,
});

/** One of Grok's own `updates.jsonl` rows. */
export const updateRow = (update: Record<string, unknown>) => ({
	timestamp: 1789856107,
	method: '_x.ai/session/update',
	params: { sessionId: 's', update },
});

/** A `background_tasks` snapshot: `[task_id, kind, status]` per task. */
export const tasksRow = (...tasks: [id: string, kind: string, status: string][]) =>
	updateRow({
		sessionUpdate: 'background_tasks',
		tasks: tasks.map(([task_id, kind, status]) => ({ task_id, kind, status })),
	});

export const taskCompletedRow = (id: string, exitCode = 0) =>
	updateRow({
		sessionUpdate: 'task_completed',
		task_snapshot: { task_id: id, exit_code: exitCode },
	});

/** A streamed chunk row: most of what `updates.jsonl` holds. */
export const chunkRow = (sessionUpdate: string, text = 'x') => ({
	timestamp: 1789856107,
	method: 'session/update',
	params: { sessionId: 's', update: { sessionUpdate, content: { type: 'text', text } } },
});
