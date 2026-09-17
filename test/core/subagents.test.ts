import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents } from '../../src/index.js';
import type { WatchContext } from '../../src/provider.js';

function mem(run: (ctx: WatchContext) => void) {
	return {
		id: 'mem',
		harness: 'Memory' as const,
		watch(ctx: WatchContext) {
			run(ctx);
			return () => {};
		},
	};
}

const procs = { info: async () => ({ alive: true }), watch: () => 'unsupported' as const };

test('subagent start dedupe, end once, end-without-start ignored', async () => {
	const aya = AllYourAgents({
		providers: [
			mem((ctx) => {
				ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem' });
				const start = {
					id: 'a',
					sessionId: 's',
					harness: 'Memory' as const,
					type: 'Explore',
					background: false,
				};
				ctx.emit('subagent:start', start);
				ctx.emit('subagent:start', start);
				ctx.emit('subagent:end', { sessionId: 's', id: 'a', status: 'completed' });
				ctx.emit('subagent:end', { sessionId: 's', id: 'a', status: 'failed' });
				ctx.emit('subagent:end', { sessionId: 's', id: 'ghost', status: 'completed' });
			}),
		],
		processes: procs,
	});
	const events: string[] = [];
	aya.on('subagent:start', (s) => events.push(`start:${s.id}`));
	aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
	await aya.start();
	assert.deepEqual(events, ['start:a', 'end:a:completed']);
	assert.equal(aya.running()[0]?.activity.openSubagents, 0);
	await aya.stop();
});

test('cancel on session close before session:close', async () => {
	const aya = AllYourAgents({
		providers: [
			mem((ctx) => {
				ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem', pid: 1 });
				ctx.emit('subagent:start', {
					id: 'a',
					sessionId: 's',
					harness: 'Memory',
					type: 'Explore',
					background: true,
				});
				ctx.emit('session:close', { id: 's' });
			}),
		],
		processes: procs,
	});
	const events: string[] = [];
	aya.on('subagent:end', (s) => events.push(`end:${s.status}`));
	aya.on('session:close', () => events.push('close'));
	await aya.start();
	assert.deepEqual(events, ['end:cancelled', 'close']);
	await aya.stop();
});

test('catch-up of running subagent before ready', async () => {
	const aya = AllYourAgents({
		providers: [
			mem((ctx) => {
				ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem' });
				ctx.emit('subagent:start', {
					id: 'bg',
					sessionId: 's',
					harness: 'Memory',
					type: 'Explore',
					background: true,
				});
			}),
		],
		processes: procs,
	});
	const events: string[] = [];
	aya.on('subagent:start', (_s, _sess, meta) => events.push(`start:${meta.catchUp}`));
	aya.on('ready', () => events.push('ready'));
	await aya.start();
	assert.deepEqual(events, ['start:true', 'ready']);
	const kids = await aya.running()[0]?.subagents();
	assert.equal(kids?.[0]?.id, 'bg');
	await aya.stop();
});
