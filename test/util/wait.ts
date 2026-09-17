export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
	fn: () => T | undefined | false | null,
	timeout = 2000,
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

/**
 * macOS serves every `fs.watch` in a process from one FSEvents stream, rebuilt whenever a
 * watch opens or closes, and an event landing in the first moments after that can be
 * lost. A test that writes straight after opening a watch waits this out first.
 */
export function settle(): Promise<void> {
	return sleep(50);
}
