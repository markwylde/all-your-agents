import type { Fs, Processes } from '../../src/helpers/types.js';
import type { Provider, WatchContext } from '../../src/provider.js';
import { codexCli } from '../../src/providers/codex-cli/index.js';
import { grokBuild } from '../../src/providers/grok-build/index.js';
import type {
	EventMeta,
	Harness,
	Session,
	SessionActivity,
	SessionEvent,
	SessionFilter,
	SessionKind,
	SessionSnapshot,
	SessionStatus,
	Subagent,
	SubagentStatus,
	TitleSource,
	Turn,
	TurnFact,
} from '../../src/types.js';

const harness: Harness = 'ClaudeCode';
const status: SessionStatus = 'running';
const kind: SessionKind = 'headless';
const filter: SessionFilter = { since: 0, kind, harness, cwd: '/tmp', live: true };
const meta: EventMeta = { catchUp: true };

const snapshot: SessionSnapshot = {
	id: 's1',
	harness,
	provider: 'claude-code',
	kind,
	cwd: '/tmp',
	title: 't',
	startedAt: 1,
	updatedAt: 2,
};

const activity: SessionActivity = { openSubagents: 0, lastTurn: 'completed', lastTurnEndedAt: 1 };

const events: SessionEvent[] = [
	{ kind: 'user', text: 'hi', raw: {}, at: 1 },
	{ kind: 'assistant', text: 'yo', model: 'x', raw: {}, at: 2 },
	{ kind: 'tool', id: 't1', name: 'Bash', raw: {} },
	{ kind: 'tool-result', id: 't1', isError: false, raw: {} },
	{ kind: 'title', title: 'Hello', source: 'harness', raw: {} },
	{ kind: 'turn-end', raw: {} },
	{ kind: 'subagent', id: 'a1', title: 'Explore', type: 'Explore', background: false, raw: {} },
	{ kind: 'subagent-end', id: 'a1', status: 'completed', raw: {} },
	{ kind: 'error', message: 'nope', raw: {} },
	{ kind: 'other', raw: {} },
];

const turn: Turn = { events, outcome: 'completed', startedAt: 1, endedAt: 2 };

const session = {
	...snapshot,
	activity,
	status,
	transcript: async function* () {
		yield turn;
	},
	events: () => ({
		close() {},
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
	}),
	subagents: async () => [] as Subagent[],
} satisfies Session;

const source: TitleSource = 'prompt';
const subStatus: SubagentStatus = 'running';
const fact: TurnFact = { type: 'turn-started' };

void filter;
void meta;
void session;
void source;
void subStatus;
void fact;

const fs = {} as Fs;
const processes = {} as Processes;

const provider: Provider = {
	id: 'custom',
	harness: 'Example',
	watch(ctx: WatchContext) {
		ctx.emit('session:create', { id: '1', harness: 'Example', provider: 'custom' });
		ctx.emit('session:status', { id: '1', status: 'idle' });
		ctx.emit('title', { id: '1', title: 'n', source: 'process' });
		ctx.emit('turn', { sessionId: '1', type: 'turn-started' });
		return () => {
			void ctx.fs;
			void ctx.processes;
			void fs;
			void processes;
		};
	},
};

void provider;

const grok: Provider = grokBuild({ home: '/tmp/grok' });
const grokHarness: Harness = grok.harness;
void grokHarness;

const codex: Provider = codexCli({ home: '/tmp/codex' });
void codex.harness;
