import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AllYourAgents } from '../../src/index.js';
import { grokBuild } from '../../src/providers/grok-build/index.js';
import { createGrokFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-grok-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

defineConformanceTests({
	name: 'grok-build',
	provider: grokBuild({ home }),
	driver: createGrokFixtureDriver(home),
});

test('grok-build driver: the subagent sequence produces each lifecycle event once', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'aya-grok-kit-'));
	const driver = createGrokFixtureDriver(dir);
	const processes = {
		info: async () => ({ alive: true, startTime: Date.now() }),
		watch: () => ({ stop() {} }),
	};
	const aya = AllYourAgents({ providers: [grokBuild({ home: dir })], processes });
	const events: string[] = [];
	aya.on('subagent:start', (s) => events.push(`start:${s.id}:${s.parentId ?? ''}:${s.background}`));
	aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
	aya.on('session:close', (s) => events.push(`close:${s.id}`));
	try {
		await aya.start();
		const id = '00000000-0000-4000-8000-0000000000aa';
		await driver.createLiveSession({ id, pid: 4, status: 'busy' });
		const fg = await driver.launchForegroundSubagent(id);
		const nested = await driver.launchNestedSubagent(id, fg.subagentId);
		await driver.finishForegroundSubagent(id, fg.subagentId);
		const bg = await driver.launchBackgroundSubagent(id);
		await driver.rewriteStatus(id, 'idle');
		await driver.finishBackgroundSubagent(id, bg.subagentId);
		await driver.remove(id);
		assert.deepEqual(events, [
			`start:${fg.subagentId}::false`,
			`start:${nested.subagentId}:${fg.subagentId}:false`,
			`end:${fg.subagentId}:completed`,
			`start:${bg.subagentId}::true`,
			`end:${nested.subagentId}:cancelled`,
			`end:${bg.subagentId}:completed`,
			`close:${id}`,
		]);
	} finally {
		await aya.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
