import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialEventsState, reduceRecord } from '../../../src/providers/codex-cli/events.js';
import {
	PERSISTED_EVENT_MSG_TYPES,
	REDUCER_EVENT_MSG_TYPES,
	TRANSIENT_EVENT_MSG_TYPES,
} from '../../../src/providers/codex-cli/persisted-events.js';
import { eventMsg } from './home.js';

test('reducer only acts on persisted event_msg types', () => {
	const persisted = new Set<string>(PERSISTED_EVENT_MSG_TYPES);
	for (const type of REDUCER_EVENT_MSG_TYPES) {
		assert.ok(persisted.has(type), type);
	}
	for (const type of TRANSIENT_EVENT_MSG_TYPES) {
		assert.equal(persisted.has(type), false, type);
		const state = initialEventsState();
		state.turnOpen = true;
		const facts = reduceRecord(state, eventMsg(type));
		assert.deepEqual(facts, []);
		assert.equal(state.turnOpen, true);
	}
});
