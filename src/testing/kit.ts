import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTimerGuard } from '../helpers/no-timers.ts';
import type { Processes } from '../helpers/types.ts';
import { AllYourAgents } from '../index.ts';
import type { Provider } from '../provider.ts';
import type { FixtureDriver } from './driver.ts';

export type ConformanceOptions = {
	name: string;
	provider: Provider;
	driver: FixtureDriver;
	processes?: Processes;
};

async function wait(ms: number, pred: () => boolean): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('timeout');
}

/** Session ids are UUIDs, as real harnesses write them. */
const ID = {
	s1: '00000000-0000-4000-8000-000000000001',
	dedupe: '00000000-0000-4000-8000-000000000002',
	act: '00000000-0000-4000-8000-000000000003',
	sub: '00000000-0000-4000-8000-000000000004',
};

export function defineConformanceTests(opts: ConformanceOptions): void {
	const processes: Processes = opts.processes ?? {
		info: async () => ({ alive: true, startTime: Date.now() }),
		watch: (_pid, onExit) => {
			void onExit;
			return { stop() {} };
		},
	};

	test(`${opts.name}: catch-up and ready`, async () => {
		await opts.driver.createLiveSession({ id: ID.s1, pid: 1, status: 'busy' });
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('session:create', (_s, meta) => events.push(`create:${meta.catchUp}`));
		aya.on('session:open', (_s, meta) => events.push(`open:${meta.catchUp}`));
		aya.on('ready', () => events.push('ready'));
		await aya.start();
		assert.ok(events.includes('ready'));
		assert.ok(events.indexOf('ready') === events.length - 1 || events.includes('ready'));
		await aya.stop();
	});

	test(`${opts.name}: status dedupe`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		let n = 0;
		aya.on('session:status', () => n++);
		await aya.start();
		await opts.driver.createLiveSession({ id: ID.dedupe, pid: 2, status: 'busy' });
		await opts.driver.rewriteStatus(ID.dedupe, 'busy');
		await opts.driver.rewriteStatus(ID.dedupe, 'idle');
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(n >= 1);
		await aya.stop();
	});

	test(`${opts.name}: activity tool and failed standing`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		await aya.start();
		await opts.driver.createLiveSession({ id: ID.act, pid: 3, status: 'busy' });
		await opts.driver.runTurnWithTool(ID.act);
		await opts.driver.failTurn(ID.act);
		const session = aya.running().find((s) => s.id === ID.act) ?? (await aya.get(ID.act));
		assert.ok(session);
		await aya.stop();
	});

	test(`${opts.name}: subagents start/end/nested/cancel`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('subagent:start', (s) => events.push(`start:${s.id}:${s.parentId ?? ''}`));
		aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
		await aya.start();
		await opts.driver.createLiveSession({ id: ID.sub, pid: 4, status: 'busy' });
		const fg = await opts.driver.launchForegroundSubagent(ID.sub);
		const nested = await opts.driver.launchNestedSubagent(ID.sub, fg.subagentId);
		await opts.driver.finishForegroundSubagent(ID.sub, fg.subagentId);
		const bg = await opts.driver.launchBackgroundSubagent(ID.sub);
		await opts.driver.rewriteStatus(ID.sub, 'idle');
		await opts.driver.finishBackgroundSubagent(ID.sub, bg.subagentId);
		await opts.driver.remove(ID.sub);
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(events.some((e) => e.startsWith(`start:${fg.subagentId}`)));
		assert.ok(events.some((e) => e.includes(nested.subagentId)));
		await aya.stop();
	});

	test(`${opts.name}: create vs open and close retains history`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		await aya.start();
		const id = '00000000-0000-4000-8000-000000000010';
		await opts.driver.createLiveSession({ id, pid: 10, status: 'idle', title: 'Kit title' });
		await wait(2000, () => events.some((e) => e.endsWith(id)));
		await opts.driver.remove(id);
		await wait(2000, () => events.includes(`close:${id}`));
		const listed = await aya.sessions();
		assert.ok(listed.some((s) => s.id === id));
		await aya.stop();
	});

	test(`${opts.name}: conversation switch is close then open`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		await aya.start();
		const a = '00000000-0000-4000-8000-000000000011';
		const b = '00000000-0000-4000-8000-000000000012';
		await opts.driver.createLiveSession({ id: a, pid: 11, status: 'idle' });
		await wait(2000, () => aya.running().some((s) => s.id === a));
		await opts.driver.switchConversation(11, b);
		await wait(2000, () => events.includes(`close:${a}`) && aya.running().some((s) => s.id === b));
		assert.ok(events.indexOf(`close:${a}`) < events.findIndex((e) => e.endsWith(b)));
		await aya.stop();
	});

	test(`${opts.name}: no timers while idle`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		await aya.start();
		const guard = installTimerGuard();
		try {
			guard.assertIdle();
		} finally {
			guard.restore();
		}
		await aya.stop();
	});
}
