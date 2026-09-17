import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../../src/helpers/clock.js';
import { coalesce } from '../../src/helpers/coalesce.js';
import { installTimerGuard } from '../../src/helpers/no-timers.js';

test('timer guard fails on a deliberate timer and passes when idle', async () => {
	const guard = installTimerGuard();
	try {
		assert.throws(() => {
			setTimeout(() => {}, 50);
			guard.assertIdle();
		});
		guard.restore();
	} finally {
		guard.restore();
	}

	const idle = installTimerGuard();
	try {
		idle.assertIdle();
	} finally {
		idle.restore();
	}

	const clock = new FakeClock();
	const c = coalesce(25, 1000, clock);
	c.notify('/x', () => {});
	clock.advance(25);
	assert.equal(c.pending(), 0);
	assert.equal(clock.pending(), 0);
});
