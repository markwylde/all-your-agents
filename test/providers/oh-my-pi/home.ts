import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Processes } from '../../../src/helpers/types.js';

export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';
export const C = '00000000-0000-4000-8000-00000000000c';

export const STAMP = '2026-01-01T00-00-00-000Z';

export async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-omp-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

export function encodeCwd(cwd: string): string {
	return `-${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}-`;
}

export function sessionPath(home: string, id: string, cwd = '/tmp/app', root = home): string {
	return join(root, 'agent', 'sessions', encodeCwd(cwd), `${STAMP}_${id}.jsonl`);
}

export function artifacts(path: string): string {
	return path.slice(0, -'.jsonl'.length);
}

const iso = (at?: number) => new Date(at ?? Date.now()).toISOString();

export function slot(title = '', source = 'auto') {
	return { type: 'title', v: 1, title, source, updatedAt: iso(), pad: ' '.repeat(40) };
}

/**
 * Seen live, a session may still be binding, and a child stamped in the very millisecond the
 * bind began counts as already there. One stamped a millisecond on was born after it.
 */
export const afterBind = () => Date.now() + 1;

export function header(id: string, over: Record<string, unknown> = {}, at?: number) {
	return { type: 'session', version: 3, id, timestamp: iso(at), cwd: '/tmp/app', ...over };
}

export function entry(type: string, body: Record<string, unknown> = {}, at?: number) {
	return { type, id: randomBytes(4).toString('hex'), parentId: null, timestamp: iso(at), ...body };
}

export function user(text: string, at?: number) {
	return entry('message', { message: { role: 'user', content: [{ type: 'text', text }] } }, at);
}

export function role(name: string, text: string) {
	return entry('message', { message: { role: name, content: [{ type: 'text', text }] } });
}

export function toolCall(id: string, name: string) {
	return { type: 'toolCall', id, name, arguments: '{}' };
}

export function assistant(
	stopReason: string,
	content: unknown[] = [{ type: 'text', text: 'ok' }],
	over: Record<string, unknown> = {},
	at?: number,
) {
	return entry(
		'message',
		{
			message: {
				role: 'assistant',
				content,
				provider: 'xai-oauth',
				model: 'grok-4.6',
				stopReason,
				...over,
			},
		},
		at,
	);
}

export function marker(toolCallId: string, toolName: string) {
	return entry('custom', {
		customType: 'tool_execution_start',
		data: { toolCallId, toolName, startedAt: iso() },
	});
}

export function toolResult(
	toolCallId: string,
	toolName: string,
	details: unknown = {},
	isError = false,
) {
	return entry('message', {
		message: {
			role: 'toolResult',
			toolCallId,
			toolName,
			content: [{ type: 'text', text: 'ok' }],
			details,
			isError,
		},
	});
}

/** A `bash` result omp moved to the background: the job outlives the call. */
export function backgrounded(toolCallId: string, jobId: string, at?: number) {
	return entry(
		'message',
		{
			message: {
				role: 'toolResult',
				toolCallId,
				toolName: 'bash',
				content: [
					{
						type: 'text',
						text: `Backgrounded as job ${jobId}; result will be delivered automatically.`,
					},
				],
				details: { async: { state: 'running', jobId, type: 'bash' }, timeoutSeconds: 120 },
			},
		},
		at,
	);
}

/** The note omp injects when background jobs report back. */
export function asyncResult(jobIds: string[], at?: number) {
	return entry(
		'custom_message',
		{
			customType: 'async-result',
			content: `<system-notice>\n${jobIds.map((id) => `Background job ${id} has completed.`).join('\n')}\n</system-notice>`,
			details: {
				jobs: jobIds.map((jobId) => ({
					jobId,
					type: 'bash',
					label: 'sleep 60 && echo done',
					durationMs: 60009,
				})),
			},
		},
		at,
	);
}

/** A `hub` result listing jobs it waited on, each with the status it found. */
export function hubResult(toolCallId: string, jobs: Record<string, string>) {
	return toolResult(toolCallId, 'hub', {
		op: 'wait',
		jobs: Object.entries(jobs).map(([id, status]) => ({ id, type: 'bash', status })),
	});
}

export function sessionExit(at?: number) {
	return entry(
		'custom',
		{ customType: 'session_exit', data: { reason: 'dispose', kind: 'normal' } },
		at,
	);
}

export function titleChange(title: string, source = 'auto') {
	return entry('title_change', { title, source });
}

export function modelChange(model: string) {
	return entry('model_change', { model });
}

export const lines = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

export async function writeTranscript(path: string, records: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, lines(records));
}

export async function appendTranscript(path: string, records: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, lines(records));
}

export function presencePath(home: string, pid: number, hash = 'a1b2c3d4e5f60718', root = home) {
	return join(root, 'run', 'daemons', hash, 'clients', `${pid}-0000.json`);
}

export async function writePresence(
	home: string,
	pid: number,
	opts: { hash?: string; root?: string; body?: string } = {},
): Promise<string> {
	const path = presencePath(home, pid, opts.hash, opts.root);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		opts.body ?? JSON.stringify({ pid, id: `${pid}-0000`, projectDir: '/tmp/app' }),
	);
	return path;
}

export async function writeBreadcrumb(
	home: string,
	terminal: string,
	path: string,
	opts: { fresh?: boolean; cwd?: string; root?: string; body?: string } = {},
): Promise<string> {
	const file = join(opts.root ?? home, 'agent', 'terminal-sessions', terminal);
	await mkdir(dirname(file), { recursive: true });
	const extras = opts.fresh ? 'fresh\n' : '';
	await writeFile(file, opts.body ?? `${opts.cwd ?? '/tmp/app'}\n${path}\n${extras}cwdstat 1 1\n`);
	return file;
}

export function fakeOmpProcesses(start = Date.now() - 1000) {
	const alive = new Map<number, { alive: boolean; startTime?: number }>();
	const exits = new Map<number, () => void>();
	const ttys = new Map<number, string>();
	let supportsWatch = true;
	const processes: Processes & {
		fire(pid: number): void;
		set(pid: number, tty: string | undefined, startTime?: number): void;
		kill(pid: number): void;
		unsupported(): void;
	} = {
		async info(pid) {
			return alive.get(pid) ?? { alive: false };
		},
		watch(pid, onExit) {
			if (!supportsWatch) return 'unsupported';
			exits.set(pid, onExit);
			return {
				stop() {
					exits.delete(pid);
				},
			};
		},
		async tty(pid) {
			return ttys.get(pid);
		},
		/** The process exits and the kernel says so. */
		fire(pid) {
			alive.set(pid, { alive: false });
			exits.get(pid)?.();
		},
		/** The process exits and nothing tells us. */
		kill(pid) {
			alive.set(pid, { alive: false });
		},
		set(pid, tty, startTime = start) {
			alive.set(pid, { alive: true, startTime });
			if (tty) ttys.set(pid, tty);
			else ttys.delete(pid);
		},
		unsupported() {
			supportsWatch = false;
		},
	};
	return processes;
}

/** A process on `terminal`, its presence file, its transcript (unless fresh) and its breadcrumb. */
export async function launch(
	home: string,
	procs: ReturnType<typeof fakeOmpProcesses>,
	o: {
		id: string;
		pid: number;
		terminal: string;
		records?: unknown[];
		fresh?: boolean;
		cwd?: string;
	},
): Promise<string> {
	const cwd = o.cwd ?? '/tmp/app';
	const path = sessionPath(home, o.id, cwd);
	procs.set(o.pid, o.terminal.replace('pts-', 'pts/'));
	if (!o.fresh) await writeTranscript(path, [slot(), header(o.id, { cwd }), ...(o.records ?? [])]);
	await writePresence(home, o.pid);
	await writeBreadcrumb(home, o.terminal, path, { fresh: o.fresh, cwd });
	return path;
}
