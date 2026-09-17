import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../../src/helpers/clock.js';
import { coalesce } from '../../src/helpers/coalesce.js';

test('100 notifications in 200 ms → 1 read', () => {
	const clock = new FakeClock();
	const c = coalesce(25, 1000, clock);
	let reads = 0;
	for (let i = 0; i < 100; i++) {
		c.notify('/f', () => {
			reads++;
		});
		clock.advance(2);
	}
	clock.advance(25);
	assert.equal(reads, 1);
	assert.equal(c.pending(), 0);
});

test('30/s for 10 s → about 10 reads', () => {
	const clock = new FakeClock();
	const c = coalesce(25, 1000, clock);
	let reads = 0;
	// Faster than the 25 ms quiet window so the ceiling (1 s) is what fires.
	for (let i = 0; i < 500; i++) {
		c.notify('/f', () => {
			reads++;
		});
		clock.advance(20);
	}
	clock.advance(25);
	assert.ok(reads >= 8 && reads <= 12, `expected ~10 reads, got ${reads}`);
});

test('1 notification → read at 25 ms', () => {
	const clock = new FakeClock();
	const c = coalesce(25, 1000, clock);
	let at: number | undefined;
	c.notify('/f', () => {
		at = clock.now();
	});
	clock.advance(24);
	assert.equal(at, undefined);
	clock.advance(1);
	assert.equal(at, 25);
});

test('idle → no pending timer', () => {
	const clock = new FakeClock();
	const c = coalesce(25, 1000, clock);
	assert.equal(c.pending(), 0);
	assert.equal(clock.pending(), 0);
	c.notify('/f', () => {});
	assert.ok(c.pending() > 0);
	clock.advance(25);
	assert.equal(c.pending(), 0);
	assert.equal(clock.pending(), 0);
});
