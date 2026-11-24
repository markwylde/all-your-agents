import type { SqliteRow } from '../../../src/helpers/types.js';
import { proto, row } from '../../../src/testing/antigravity-driver.js';

export { proto, row, varint } from '../../../src/testing/antigravity-driver.js';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const user = (idx = 0): SqliteRow => row(idx, 14, 19, proto([2, 'Hello fixture']));
export const assistant = (idx = 1, reason = 2, status = 3): SqliteRow =>
	row(idx, 15, 20, proto([1, 'Fixture reply'], [12, reason]), status);
export const summary = (id = A): SqliteRow => ({
	conversation_id: id,
	title: 'Fixture title',
	workspace_uris: '["file:///tmp/aya%20project"]',
	status: 'CASCADE_RUN_STATUS_IDLE',
	parent_conversation_id: '',
	last_modified_time: '2027-01-15 08:00:00+00:00',
});
