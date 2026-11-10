import type { SqliteRow } from '../../../src/helpers/types.js';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export function varint(value: number): number[] {
	const bytes: number[] = [];
	do {
		const byte = value % 128;
		value = Math.floor(value / 128);
		bytes.push(byte | (value ? 128 : 0));
	} while (value);
	return bytes;
}
export function proto(...entries: [number, number | string | Uint8Array][]): Uint8Array {
	return new Uint8Array(
		entries.flatMap(([key, value]) => {
			if (typeof value === 'number') return [...varint(key * 8), ...varint(value)];
			const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
			return [...varint(key * 8 + 2), ...varint(bytes.length), ...bytes];
		}),
	);
}
export function row(
	idx: number,
	type: number,
	payloadKey: number,
	body: Uint8Array,
	status = 3,
	metadata?: Uint8Array,
): SqliteRow {
	return {
		idx,
		step_type: type,
		status,
		step_format: 0,
		step_payload: proto(
			[1, type],
			[4, status],
			[5, metadata ?? proto([1, proto([1, 1800000000 + idx])], [8, proto([1, 1800000001 + idx])])],
			[payloadKey, body],
		),
	};
}
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
