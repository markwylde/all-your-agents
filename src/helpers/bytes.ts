const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function decodeUtf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
	return encoder.encode(text);
}

export class TooLargeError extends Error {
	readonly code = 'TOO_LARGE';
	constructor(path: string, size: number, maxBytes: number) {
		super(`${path} is ${size} bytes, max ${maxBytes}`);
		this.name = 'TooLargeError';
	}
}
