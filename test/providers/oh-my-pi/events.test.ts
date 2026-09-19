import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	childOutcome,
	deriveStatus,
	dropStaleJobs,
	endStaleTurn,
	initialEventsState,
	promptSubmitted,
	reduceRecord,
	replayRecords,
} from '../../../src/providers/oh-my-pi/events.js';
import { jobChanges, mapRecord } from '../../../src/providers/oh-my-pi/journal.js';
import {
	PERSISTED_CUSTOM_TYPES,
	PERSISTED_ENTRY_TYPES,
	PERSISTED_ROLES,
	PERSISTED_STOP_REASONS,
	REDUCER_CUSTOM_TYPES,
	REDUCER_ENTRY_TYPES,
	REDUCER_ROLES,
	REDUCER_STOP_REASONS,
} from '../../../src/providers/oh-my-pi/persisted-entries.js';
import {
	assistant,
	asyncResult,
	backgrounded,
	entry,
	hubResult,
	marker,
	modelChange,
	role,
	sessionExit,
	titleChange,
	toolCall,
	toolResult,
	user,
} from './home.js';

const types = (facts: { type: string }[]) => facts.map((f) => f.type);

test('status follows the last conversation record, for every stopReason', () => {
	const cases: [unknown[], string][] = [
		[[], 'idle'],
		[[user('hi')], 'running'],
		[[user('hi'), assistant('toolUse', [toolCall('t', 'bash')])], 'running'],
		[
			[user('hi'), assistant('toolUse', [toolCall('t', 'bash')]), toolResult('t', 'bash')],
			'running',
		],
		[[user('hi'), assistant('stop')], 'idle'],
		[[user('hi'), assistant('length')], 'idle'],
		[[user('hi'), assistant('error', [], { errorMessage: 'boom' })], 'idle'],
		[[user('hi'), assistant('aborted', [])], 'idle'],
	];
	for (const [records, status] of cases) {
		assert.equal(deriveStatus(replayRecords(records).state).status, status);
	}
});

test('a background job left running makes an ended turn wait on the shell', () => {
	const job = (id: string) => [
		assistant('toolUse', [toolCall(`call-${id}`, 'bash')]),
		backgrounded(`call-${id}`, id),
	];
	const asking = [assistant('toolUse', [toolCall('a1', 'ask')]), marker('a1', 'ask')];
	const cases: [unknown[], ReturnType<typeof deriveStatus>][] = [
		[[user('hi'), ...job('bg_1')], { status: 'running' }],
		[[user('hi'), ...job('bg_1'), assistant('stop')], { status: 'waiting', waitingFor: 'shell' }],
		[
			[user('hi'), ...job('bg_1'), assistant('aborted', [])],
			{ status: 'waiting', waitingFor: 'shell' },
		],
		// An open turn keeps its own status, whatever runs behind it.
		[[user('hi'), ...job('bg_1'), ...asking], { status: 'waiting', waitingFor: 'ask' }],
		[[user('hi'), ...job('bg_1'), assistant('stop'), user('more')], { status: 'running' }],
		[
			[user('hi'), ...job('bg_1'), ...job('bg_2'), assistant('stop'), asyncResult(['bg_1'])],
			{ status: 'waiting', waitingFor: 'shell' },
		],
		[
			[
				user('hi'),
				...job('bg_1'),
				...job('bg_2'),
				assistant('stop'),
				asyncResult(['bg_1']),
				assistant('stop'),
			],
			{ status: 'waiting', waitingFor: 'shell' },
		],
		[
			[
				user('hi'),
				...job('bg_1'),
				...job('bg_2'),
				assistant('stop'),
				asyncResult(['bg_1']),
				assistant('stop'),
				asyncResult(['bg_2']),
				assistant('stop'),
			],
			{ status: 'idle' },
		],
		[[user('hi'), ...job('bg_1'), assistant('stop'), asyncResult(['bg_1'])], { status: 'idle' }],
		[[user('hi'), ...job('bg_1'), assistant('stop'), sessionExit()], { status: 'idle' }],
	];
	for (const [records, status] of cases) {
		assert.deepEqual(deriveStatus(replayRecords(records).state), status);
	}
});

test('a job started before the process now on the session is dropped', () => {
	const { state } = replayRecords([
		user('x', 1000),
		assistant('toolUse', [toolCall('c1', 'bash')], {}, 1100),
		backgrounded('c1', 'bg_1', 1200),
		assistant('stop', undefined, {}, 1300),
	]);
	dropStaleJobs(state, undefined);
	dropStaleJobs(state, 1200);
	assert.deepEqual(deriveStatus(state), { status: 'waiting', waitingFor: 'shell' });
	dropStaleJobs(state, 5000);
	assert.deepEqual(deriveStatus(state), { status: 'idle' });
});

test('turn facts: one tool start and finish, keyed by the call id, marker not counted', () => {
	const { facts } = replayRecords([
		user('run'),
		assistant('toolUse', [{ type: 'text', text: 'on it' }, toolCall('call-1|fc_1', 'bash')]),
		marker('call-1|fc_1', 'bash'),
		toolResult('call-1|fc_1', 'bash', {}, true),
		assistant('stop'),
	]);
	assert.deepEqual(types(facts), ['turn-started', 'tool-started', 'tool-finished', 'turn-ended']);
	const started = facts[1];
	assert.ok(
		started?.type === 'tool-started' && started.id === 'call-1|fc_1' && started.name === 'bash',
	);
	const ended = facts[3];
	assert.ok(ended?.type === 'turn-ended' && ended.outcome === 'completed');
});

test('error fails the turn with its message; aborted interrupts it', () => {
	const failed = replayRecords([
		user('x'),
		assistant('error', [], { errorMessage: 'rate limited' }),
	]);
	const end = failed.facts.at(-1);
	assert.ok(end?.type === 'turn-ended' && end.outcome === 'failed' && end.error === 'rate limited');
	const aborted = replayRecords([user('x'), assistant('aborted', [])]).facts.at(-1);
	assert.ok(aborted?.type === 'turn-ended' && aborted.outcome === 'interrupted');
});

test('a retry after an error starts a new turn without a prompt', () => {
	const state = initialEventsState();
	replayRecords([user('x'), assistant('error', [], { errorMessage: 'boom' })], state);
	const facts = reduceRecord(state, assistant('toolUse', [toolCall('t2', 'read')]));
	assert.deepEqual(types(facts), ['turn-started', 'tool-started']);
	assert.equal(deriveStatus(state).status, 'running');
});

test('ask waits once it is executing, until its result', () => {
	const state = initialEventsState();
	replayRecords([user('x'), assistant('toolUse', [toolCall('a1', 'ask')])], state);
	assert.deepEqual(deriveStatus(state), { status: 'running' });
	reduceRecord(state, marker('a1', 'ask'));
	assert.deepEqual(deriveStatus(state), { status: 'waiting', waitingFor: 'ask' });
	reduceRecord(state, toolResult('a1', 'ask'));
	assert.deepEqual(deriveStatus(state), { status: 'running' });
});

test('bookkeeping and injected roles leave status alone and never start a turn', () => {
	const state = initialEventsState();
	const quiet = [
		role('developer', 'system note'),
		role('fileMention', '@file'),
		entry('custom_message', { customType: 'async-result', content: '<task-result/>' }),
		entry('thinking_level_change', { level: 'high' }),
		entry('credential_pin', {}),
		entry('ttsr_injection', {}),
		entry('something_new', {}),
		titleChange('A title'),
		'not an object',
	];
	for (const rec of quiet) assert.deepEqual(reduceRecord(state, rec), []);
	assert.equal(deriveStatus(state).status, 'idle');
	reduceRecord(state, modelChange('xai-oauth/grok-4.6'));
	assert.equal(state.model, 'xai-oauth/grok-4.6');
	reduceRecord(state, user('x'));
	reduceRecord(state, assistant('stop', undefined, { provider: 'anthropic', model: 'opus' }));
	assert.equal(state.model, 'anthropic/opus');
});

test('session_exit interrupts an open turn and means nothing otherwise', () => {
	const open = replayRecords([user('x'), sessionExit()]).facts.at(-1);
	assert.ok(open?.type === 'turn-ended' && open.outcome === 'interrupted');
	assert.deepEqual(types(replayRecords([user('x'), assistant('stop'), sessionExit()]).facts), [
		'turn-started',
		'turn-ended',
	]);
});

test('first turn from history: started once, ended by the transcript', () => {
	const state = initialEventsState();
	assert.deepEqual(types(promptSubmitted(state, 1000)), ['turn-started']);
	assert.equal(deriveStatus(state).status, 'running');
	// A second row while the turn is open changes nothing.
	assert.deepEqual(promptSubmitted(state, 1001), []);
	// The transcript materialises: its user message is that same prompt.
	assert.deepEqual(reduceRecord(state, user('the prompt')), []);
	assert.deepEqual(types(reduceRecord(state, assistant('stop'))), ['turn-ended']);

	const failing = initialEventsState();
	promptSubmitted(failing, 1000);
	reduceRecord(failing, user('the prompt'));
	const end = reduceRecord(failing, assistant('error', [], { errorMessage: 'nope' })).at(-1);
	assert.ok(end?.type === 'turn-ended' && end.outcome === 'failed' && end.error === 'nope');
});

test('a turn left open before the process started is interrupted at its start', () => {
	const { state } = replayRecords([
		user('x', 1000),
		assistant('toolUse', [toolCall('t', 'bash')], {}, 2000),
	]);
	assert.deepEqual(endStaleTurn(state, 1500), []);
	const facts = endStaleTurn(state, 5000);
	assert.deepEqual(facts, [{ type: 'turn-ended', outcome: 'interrupted', endedAt: 5000 }]);
	assert.equal(deriveStatus(state).status, 'idle');
});

test('child outcome: yield, stop, error, aborted, exit; first one only matters to the caller', () => {
	const run = (records: unknown[]) => {
		const state = initialEventsState();
		for (const rec of records) {
			const outcome = childOutcome(state, rec);
			if (outcome) return outcome.status;
		}
		return undefined;
	};
	const yielding = [
		user('task'),
		assistant('toolUse', [toolCall('y', 'yield')]),
		marker('y', 'yield'),
	];
	assert.equal(run([...yielding, toolResult('y', 'yield', { status: 'success' })]), 'completed');
	assert.equal(run([...yielding, toolResult('y', 'yield', { status: 'error' })]), 'failed');
	// A reply that stops is not the end: omp reminds the agent to yield, and it goes on.
	assert.equal(run([user('task'), assistant('stop')]), undefined);
	assert.equal(
		run([
			user('task'),
			assistant('stop'),
			role('developer', 'call yield'),
			...yielding.slice(1),
			toolResult('y', 'yield', { status: 'success' }),
		]),
		'completed',
	);
	assert.equal(run([user('task'), assistant('error', [], { errorMessage: 'x' })]), 'failed');
	assert.equal(run([user('task'), assistant('aborted', [])]), 'cancelled');
	assert.equal(run([user('task'), sessionExit()]), 'cancelled');
	assert.equal(run([user('task'), assistant('toolUse', [toolCall('t', 'read')])]), undefined);
});

test('mapper: conversation, tools, titles, errors; bookkeeping unmapped', () => {
	const kinds = (rec: unknown) => mapRecord(rec).map((e) => e.kind);
	assert.deepEqual(kinds(user('hello')), ['user']);
	const reply = mapRecord(
		assistant('toolUse', [
			{ type: 'thinking', thinking: 'hmm' },
			{ type: 'text', text: 'on it' },
			toolCall('t1', 'bash'),
		]),
	);
	assert.deepEqual(
		reply.map((e) => e.kind),
		['assistant', 'tool'],
	);
	assert.ok(reply[0]?.kind === 'assistant' && reply[0].model === 'xai-oauth/grok-4.6');
	assert.deepEqual(kinds(assistant('stop')), ['assistant', 'turn-end']);
	assert.deepEqual(kinds(assistant('error', [], { errorMessage: 'boom' })), ['error', 'turn-end']);
	assert.deepEqual(kinds(assistant('aborted', [])), ['turn-end']);
	const result = mapRecord(toolResult('t1', 'bash', {}, true))[0];
	assert.ok(result?.kind === 'tool-result' && result.id === 't1' && result.isError === true);
	const titled = mapRecord(titleChange('Mine', 'user'))[0];
	assert.ok(titled?.kind === 'title' && titled.source === 'user');
	for (const rec of [
		role('developer', 'note'),
		entry('custom_message', { customType: 'async-result', content: 'x' }),
		entry('session_init', { agent: 'scout' }),
		modelChange('m'),
		marker('t1', 'bash'),
		entry('brand_new', {}),
	]) {
		assert.deepEqual(mapRecord(rec), []);
	}
});

test('mapper: a task result announces its agents once; a later result ends them once', () => {
	const state = {};
	const spawned = mapRecord(
		toolResult('c1', 'task', {
			progress: [
				{ id: 'PowTwoTen', agent: 'sonic', status: 'pending' },
				{ id: 'DivOne', agent: 'sonic', status: 'pending' },
			],
			async: { state: 'running' },
		}),
		state,
	);
	assert.deepEqual(
		spawned.map((e) => e.kind),
		['tool-result', 'subagent', 'subagent'],
	);
	assert.ok(
		spawned[1]?.kind === 'subagent' && spawned[1].type === 'sonic' && spawned[1].background,
	);
	const waited = toolResult('c2', 'hub', { jobs: [{ id: 'PowTwoTen', status: 'completed' }] });
	assert.deepEqual(
		mapRecord(waited, state).map((e) => e.kind),
		['tool-result', 'subagent-end'],
	);
	assert.deepEqual(
		mapRecord(waited, state).map((e) => e.kind),
		['tool-result'],
	);
});

test('mapper: background bash jobs open and close; a task agent is not one', () => {
	assert.deepEqual(jobChanges(backgrounded('call-1', 'bg_1')), { opened: ['bg_1'], closed: [] });
	assert.deepEqual(jobChanges(asyncResult(['bg_3'])), { opened: [], closed: ['bg_3'] });
	assert.deepEqual(jobChanges(hubResult('call-2', { bg_1: 'completed', bg_2: 'failed' })), {
		opened: [],
		closed: ['bg_1', 'bg_2'],
	});
	// Still running when `hub` looked: not the end of it.
	assert.deepEqual(jobChanges(hubResult('call-3', { bg_1: 'running' })), {
		opened: [],
		closed: [],
	});
	const task = toolResult('c1', 'task', {
		progress: [{ id: 'PowTwoTen', agent: 'sonic', status: 'pending' }],
		async: { state: 'running', jobId: 'PowTwoTen', type: 'task' },
	});
	assert.deepEqual(jobChanges(task).opened, []);
	// A bash result that ran to its end, and one whose job is already over, open nothing.
	assert.deepEqual(jobChanges(toolResult('c2', 'bash', { timeoutSeconds: 120 })).opened, []);
	const done = toolResult('c3', 'bash', {
		async: { state: 'completed', jobId: 'bg_9', type: 'bash' },
	});
	assert.deepEqual(jobChanges(done).opened, []);
	for (const rec of [user('hi'), assistant('stop'), sessionExit(), 'not an object']) {
		assert.deepEqual(jobChanges(rec), { opened: [], closed: [] });
	}

	const state = initialEventsState();
	replayRecords([user('x'), assistant('toolUse', [toolCall('call-1', 'bash')])], state);
	reduceRecord(state, backgrounded('call-1', 'bg_1'));
	reduceRecord(state, task);
	assert.deepEqual([...state.openJobs.keys()], ['bg_1']);
	reduceRecord(state, hubResult('call-3', { bg_1: 'running' }));
	assert.equal(state.openJobs.size, 1);
	reduceRecord(state, hubResult('call-2', { bg_1: 'completed' }));
	assert.equal(state.openJobs.size, 0);
	reduceRecord(state, backgrounded('call-4', 'bg_2'));
	reduceRecord(state, asyncResult(['bg_2']));
	assert.equal(state.openJobs.size, 0);
	reduceRecord(state, backgrounded('call-5', 'bg_3'));
	reduceRecord(state, sessionExit());
	assert.equal(state.openJobs.size, 0);
});

test('compat: everything the reducer acts on is something omp persists', () => {
	const subset = (part: readonly string[], whole: readonly string[]) =>
		part.every((item) => whole.includes(item));
	assert.ok(subset(REDUCER_ENTRY_TYPES, PERSISTED_ENTRY_TYPES));
	assert.ok(subset(REDUCER_STOP_REASONS, PERSISTED_STOP_REASONS));
	assert.ok(subset(REDUCER_CUSTOM_TYPES, PERSISTED_CUSTOM_TYPES));
	assert.ok(subset(REDUCER_ROLES, PERSISTED_ROLES));
	assert.equal(subset([...REDUCER_ENTRY_TYPES, 'turn_started'], PERSISTED_ENTRY_TYPES), false);

	// Every literal the reducer and mapper compare against is declared above.
	const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/providers/oh-my-pi');
	const text = ['events.ts', 'journal.ts']
		.map((f) => readFileSync(join(dir, f), 'utf8'))
		.join('\n');
	const literals = (pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1] ?? '');
	assert.ok(subset(literals(/entry\??\.type [!=]== '([a-z_]+)'/g), REDUCER_ENTRY_TYPES));
	assert.ok(subset(literals(/role [!=]== '([A-Za-z]+)'/g), REDUCER_ROLES));
	assert.ok(subset(literals(/case '([A-Za-z]+)':/g), REDUCER_STOP_REASONS));
	assert.ok(
		subset(
			literals(/kind === '([a-z_]+)'/g).filter((k) => k.includes('_')),
			REDUCER_CUSTOM_TYPES,
		),
	);
});
