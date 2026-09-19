import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveEnabled } from './helpers.js';

const ptyScript = join(dirname(fileURLToPath(import.meta.url)), '../../../test/e2e/omp-pty.py');

/** Runs with the other live tests: omp reads `OPENROUTER_API_KEY`, so no sign-in is needed. */
export function ompLiveEnabled(): boolean {
	return liveEnabled() && process.env.AYA_E2E_OMP !== '0';
}

export function e2eOmpModel(): string {
	return process.env.AYA_E2E_OMP_MODEL ?? 'openrouter/anthropic/claude-sonnet-5';
}

const OMP_ROLES = ['default', 'smol', 'slow', 'plan', 'commit', 'tiny', 'task', 'advisor'];

/**
 * An omp home of its own under a fake `$HOME`, with every model role on OpenRouter, so
 * subagents and title generation never reach for credentials the runner does not have.
 * `setupVersion` marks first-run setup as done; otherwise its sign-in picker holds the prompt.
 */
export async function isolatedOmpHome(): Promise<{ userHome: string; home: string }> {
	const userHome = await mkdtemp(join(tmpdir(), 'aya-e2e-omp-home-'));
	const home = join(userHome, '.omp');
	mkdirSync(join(home, 'agent'), { recursive: true });
	const roles = OMP_ROLES.map((role) => `  ${role}: ${e2eOmpModel()}`);
	writeFileSync(
		join(home, 'agent', 'config.yml'),
		['setupVersion: 2', 'modelRoles:', ...roles, ''].join('\n'),
	);
	return { userHome, home };
}

export function requireOmp(): void {
	const probe = spawnSync('omp', ['--version'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(`omp is not installed or not on PATH: ${probe.error?.message ?? probe.stderr}`);
	}
}

/**
 * A scratch project. Sessions are told apart from the user's own by this directory's name:
 * omp records the cwd without `/private`, the temp dir resolves with it.
 */
export async function ompProject(): Promise<{ cwd: string; mine(s: { cwd?: string }): boolean }> {
	const cwd = await mkdtemp(join(tmpdir(), 'aya-e2e-omp-'));
	const name = basename(cwd);
	return { cwd, mine: (s) => s.cwd != null && basename(s.cwd) === name };
}

export type OmpRun = {
	child: ChildProcess;
	done: Promise<{ code: number | null; output: string }>;
};

/** Interactive omp on a pty, with the prompt as its first message. See `omp-pty.py`. */
export function startInteractiveOmp(userHome: string, cwd: string, prompt: string): OmpRun {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is missing');
	const child = spawn('python3', [ptyScript, '--model', e2eOmpModel(), prompt], {
		cwd,
		env: {
			...process.env,
			HOME: userHome,
			OPENROUTER_API_KEY: key,
			TERM: process.env.TERM ?? 'xterm-256color',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout?.on('data', (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		output += chunk.toString();
	});
	const done = new Promise<{ code: number | null; output: string }>((resolve) => {
		child.on('exit', (code) => resolve({ code, output }));
		child.on('error', () => resolve({ code: null, output }));
	});
	return { child, done };
}

/** The driver passes SIGTERM on, and omp then exits cleanly: exit marker, presence removed. */
export function stopInteractiveOmp(run: OmpRun): void {
	run.child.kill('SIGTERM');
}

export const THREE_OMP_AGENT_PROMPT =
	'This is an automated test. Do not plan or think at length. Use the task tool once to spawn three subagents in parallel. Each must reply with only one word: ALPHA, BETA, and GAMMA. Wait until all three finish, then output DONE and stop.';
