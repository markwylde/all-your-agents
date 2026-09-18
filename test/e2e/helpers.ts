import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THREE_AGENT_PROMPT =
	'This is an automated test. Do not plan or think at length. You MUST invoke the Agent tool exactly 3 times in this turn, in parallel. Each invocation: subagent_type=general-purpose. Prompts: (1) Reply with only the word ALPHA and stop. (2) Reply with only the word BETA and stop. (3) Reply with only the word GAMMA and stop. Do not write any user-facing text until all three tool results return. Then output DONE.';

export function loadDotenv(): void {
	const roots = [
		process.cwd(),
		join(process.cwd(), '..', '..'),
		join(dirname(fileURLToPath(import.meta.url)), '../../..'),
	];
	for (const root of roots) {
		const path = join(root, '.env');
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq < 1) continue;
			const key = trimmed.slice(0, eq);
			let value = trimmed.slice(eq + 1);
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (process.env[key] == null) process.env[key] = value;
		}
	}
}

loadDotenv();

export function liveEnabled(): boolean {
	return process.env.AYA_LIVE === '1' && Boolean(process.env.OPENROUTER_API_KEY);
}

export function e2eModel(): string {
	return process.env.AYA_E2E_MODEL ?? 'anthropic/claude-haiku-4.5';
}

export function e2eEffort(): string {
	return process.env.AYA_E2E_EFFORT ?? 'none';
}

export function claudeModelArgs(): string[] {
	const args = ['--model', e2eModel()];
	const effort = e2eEffort();
	if (effort && effort !== 'none') args.push('--effort', effort);
	return args;
}

export const stubProcesses = {
	async info() {
		return { alive: true as const, startTime: Date.now() - 1000 };
	},
	watch() {
		return 'unsupported' as const;
	},
};

export function claudeEnv(home: string): NodeJS.ProcessEnv {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is missing');
	return {
		...process.env,
		CLAUDE_CONFIG_DIR: home,
		OPENROUTER_API_KEY: key,
		ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
		ANTHROPIC_AUTH_TOKEN: key,
		ANTHROPIC_API_KEY: '',
		ANTHROPIC_DEFAULT_SONNET_MODEL: e2eModel(),
		CLAUDE_CODE_SUBAGENT_MODEL: e2eModel(),
	};
}

export async function isolatedClaudeHome(): Promise<{ home: string; cwd: string }> {
	const home = await mkdtemp(join(tmpdir(), 'aya-e2e-home-'));
	const cwd = await mkdtemp(join(tmpdir(), 'aya-e2e-cwd-'));
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, 'settings.json'),
		JSON.stringify({
			permissions: { defaultMode: 'bypassPermissions' },
			skipDangerousModePermissionPrompt: true,
			theme: 'dark',
		}),
	);
	trustProject(cwd);
	return { home, cwd };
}

export function trustProject(cwd: string): void {
	const configPath = join(homedir(), '.claude.json');
	if (!existsSync(configPath)) return;
	try {
		const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
			projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
		};
		const resolved = realpathSync(cwd);
		data.projects ??= {};
		data.projects[cwd] = { ...data.projects[cwd], hasTrustDialogAccepted: true };
		data.projects[resolved] = { ...data.projects[resolved], hasTrustDialogAccepted: true };
		writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
	} catch {
		// picker test will still try the dialog
	}
}

export function startBackgroundClaude(
	home: string,
	cwd: string,
	prompt: string,
	extraArgs: string[] = [],
	opts: { inheritSavedOptions?: boolean } = {},
): { child: ChildProcess; id: Promise<string> } {
	const args = opts.inheritSavedOptions
		? ['--bg', ...extraArgs, prompt]
		: ['--bg', ...extraArgs, ...claudeModelArgs(), '--dangerously-skip-permissions', prompt];
	const child = spawn('claude', args, {
		cwd,
		env: claudeEnv(home),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let buf = '';
	const id = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no bg id in: ${buf}`)), 20_000);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			const match = /backgrounded · ([0-9a-f-]+)/i.exec(buf);
			if (match?.[1]) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', reject);
	});
	return { child, id };
}

export function stopBackgroundClaude(home: string, id: string): void {
	spawnSync('claude', ['stop', id], { env: claudeEnv(home), stdio: 'ignore' });
}

export function runPrintClaude(
	home: string,
	cwd: string,
	prompt: string,
	extraArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		'claude',
		[
			'-p',
			'--output-format',
			'text',
			'--dangerously-skip-permissions',
			...extraArgs,
			...claudeModelArgs(),
			'--max-turns',
			'8',
			prompt,
		],
		{ cwd, env: claudeEnv(home), encoding: 'utf8', timeout: 180_000 },
	);
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function collectTurns(session: {
	transcript(): AsyncIterable<{ events: { kind: string; text?: string }[] }>;
}): Promise<string[]> {
	const texts: string[] = [];
	for await (const turn of session.transcript()) {
		for (const event of turn.events) {
			if (event.kind === 'user' && event.text) texts.push(event.text);
		}
	}
	return texts;
}

export async function rmQuiet(path: string): Promise<void> {
	for (let i = 0; i < 8; i++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

export function waitUntil(
	pred: () => boolean | Promise<boolean>,
	ms: number,
	label: () => string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + ms;
		const tick = (): void => {
			void Promise.resolve(pred()).then((ok) => {
				if (ok) {
					resolve();
					return;
				}
				if (Date.now() > deadline) {
					reject(new Error(`timeout: ${label()}`));
					return;
				}
				setTimeout(tick, 50);
			}, reject);
		};
		tick();
	});
}

export function e2eGrokModel(): string {
	return process.env.AYA_E2E_GROK_MODEL ?? 'x-ai/grok-4.6';
}

export function e2eGrokEffort(): string {
	return process.env.AYA_E2E_GROK_EFFORT ?? 'low';
}

/** A Grok home whose `e2e` model is served by OpenRouter, and a cwd to run in. */
export async function isolatedGrokHome(): Promise<{ home: string; cwd: string }> {
	const home = await mkdtemp(join(tmpdir(), 'aya-e2e-grok-'));
	const cwd = await mkdtemp(join(tmpdir(), 'aya-e2e-cwd-'));
	writeFileSync(
		join(home, 'config.toml'),
		[
			'[model.e2e]',
			`model = ${JSON.stringify(e2eGrokModel())}`,
			'base_url = "https://openrouter.ai/api/v1"',
			'name = "E2E"',
			'env_key = "OPENROUTER_API_KEY"',
			'',
		].join('\n'),
	);
	return { home, cwd };
}

export function grokEnv(home: string): NodeJS.ProcessEnv {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is missing');
	// Print-mode runs register in the live index only with GROK_TRACK_HEADLESS.
	return { ...process.env, GROK_HOME: home, OPENROUTER_API_KEY: key, GROK_TRACK_HEADLESS: '1' };
}

/** Fails at once when the `grok` binary is missing, rather than timing out waiting for it. */
export function requireGrok(): void {
	const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(
			`grok is not installed or not on PATH: ${probe.error?.message ?? probe.stderr}`,
		);
	}
}

/** `grok -p` in the background; resolves with its exit code and output. */
export function startPrintGrok(
	home: string,
	cwd: string,
	prompt: string,
): { child: ChildProcess; done: Promise<{ code: number | null; output: string }> } {
	const child = spawn('grok', ['-p', prompt, '--yolo', '--effort', e2eGrokEffort(), '-m', 'e2e'], {
		cwd,
		env: grokEnv(home),
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

export const THREE_GROK_AGENT_PROMPT =
	'This is an automated test. Do not plan or think at length. You MUST call spawn_subagent exactly 3 times in this turn, in parallel, each with subagent_type=general-purpose and no background. Prompts: (1) Reply with only the word ALPHA. (2) Reply with only the word BETA. (3) Reply with only the word GAMMA. Wait for all three results, then output DONE.';

export function e2eCodexModel(): string {
	return process.env.AYA_E2E_CODEX_MODEL ?? 'x-ai/grok-4.6';
}

export function e2eCodexEffort(): string {
	return process.env.AYA_E2E_CODEX_EFFORT ?? 'low';
}

export async function isolatedCodexHome(): Promise<{ home: string; cwd: string }> {
	const home = await mkdtemp(join(tmpdir(), 'aya-e2e-codex-'));
	const cwd = await mkdtemp(join(tmpdir(), 'aya-e2e-cwd-'));
	writeFileSync(
		join(home, 'config.toml'),
		[
			`model = ${JSON.stringify(e2eCodexModel())}`,
			'model_provider = "openrouter"',
			`model_reasoning_effort = ${JSON.stringify(e2eCodexEffort())}`,
			'approval_policy = "never"',
			'sandbox_mode = "danger-full-access"',
			'',
			'[model_providers.openrouter]',
			'name = "OpenRouter"',
			'base_url = "https://openrouter.ai/api/v1"',
			'env_key = "OPENROUTER_API_KEY"',
			'wire_api = "responses"',
			'',
		].join('\n'),
	);
	return { home, cwd };
}

export function codexEnv(home: string): NodeJS.ProcessEnv {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is missing');
	return { ...process.env, CODEX_HOME: home, OPENROUTER_API_KEY: key };
}

export function requireCodex(): void {
	const probe = spawnSync('codex', ['--version'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(
			`codex is not installed or not on PATH: ${probe.error?.message ?? probe.stderr}`,
		);
	}
}

export function startExecCodex(
	home: string,
	cwd: string,
	prompt: string,
): { child: ChildProcess; done: Promise<{ code: number | null; output: string }> } {
	const child = spawn(
		'codex',
		[
			'exec',
			'-s',
			'danger-full-access',
			'--dangerously-bypass-approvals-and-sandbox',
			'-c',
			`model_reasoning_effort=${JSON.stringify(e2eCodexEffort())}`,
			'-m',
			e2eCodexModel(),
			'-C',
			cwd,
			prompt,
		],
		{ cwd, env: codexEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
	);
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

export const THREE_CODEX_AGENT_PROMPT =
	'This is an automated test. Do not plan or think at length. Spawn three collab agents in parallel immediately. Each must reply with only one word: ALPHA, BETA, and GAMMA. Wait until all three finish, then output DONE and stop.';
