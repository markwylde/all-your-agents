export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
	fn: () => T | undefined | false | null,
	timeout = 10_000,
): Promise<T> {
	const start = Date.now();
	let last: T | undefined | false | null;
	while (Date.now() - start < timeout) {
		last = fn();
		if (last) return last;
		await sleep(15);
	}
	throw new Error(`timeout waiting: last=${String(last)}`);
}
