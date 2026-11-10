/** Minimal protobuf wire reader. Schema mappings live in steps.ts; unknown fields stay opaque. */
export type Fields = Map<number, (number | Uint8Array)[]>;
export function fields(bytes: Uint8Array): Fields {
	let offset = 0;
	const result: Fields = new Map();
	const varint = (): number => {
		let value = 0;
		for (let n = 0; n < 10; n++) {
			const byte = bytes[offset++];
			if (byte == null) throw new Error('Truncated protobuf varint');
			value += (byte & 127) * 2 ** (7 * n);
			if (!(byte & 128)) {
				if (!Number.isSafeInteger(value)) throw new Error('Unsafe protobuf integer');
				return value;
			}
		}
		throw new Error('Oversized protobuf varint');
	};
	while (offset < bytes.length) {
		const tag = varint(),
			field = Math.floor(tag / 8),
			wire = tag % 8;
		if (field < 1 || field > 536870911) throw new Error('Invalid protobuf field');
		let value: number | Uint8Array;
		if (wire === 0) value = varint();
		else if (wire === 2 || wire === 1 || wire === 5) {
			const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
			if (size > bytes.length - offset) throw new Error('Truncated protobuf field');
			value = bytes.subarray(offset, offset + size);
			offset += size;
		} else throw new Error('Unsupported protobuf wire type');
		const values = result.get(field) ?? [];
		values.push(value);
		result.set(field, values);
	}
	return result;
}
export const num = (f: Fields, key: number): number | undefined => {
	const value = f.get(key)?.[0];
	return typeof value === 'number' ? value : undefined;
};
export function message(f: Fields, key: number): Fields {
	const value = f.get(key)?.[0];
	return value instanceof Uint8Array ? fields(value) : new Map();
}
const decoder = new TextDecoder('utf-8', { fatal: true });
export function str(f: Fields, key: number): string | undefined {
	const value = f.get(key)?.[0];
	return value instanceof Uint8Array ? decoder.decode(value) : undefined;
}
export function timestamp(f: Fields, key: number): number | undefined {
	const ts = message(f, key),
		seconds = num(ts, 1),
		nanos = num(ts, 2) ?? 0;
	if (seconds == null || nanos >= 1e9) return;
	const at = seconds * 1000 + nanos / 1e6;
	return Number.isFinite(at) && at > 0 ? at : undefined;
}
