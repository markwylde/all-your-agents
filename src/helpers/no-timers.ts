type TimeoutFn = typeof setTimeout;
type IntervalFn = typeof setInterval;

export type TimerGuard = {
	assertIdle(): void;
	restore(): void;
	pending(): number;
};

export function installTimerGuard(): TimerGuard {
	const pending = new Set<unknown>();
	const realSetTimeout = globalThis.setTimeout.bind(globalThis);
	const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
	const realSetInterval = globalThis.setInterval.bind(globalThis);
	const realClearInterval = globalThis.clearInterval.bind(globalThis);

	const wrappedTimeout: TimeoutFn = ((
		fn: (...a: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		const id = realSetTimeout(() => {
			pending.delete(id);
			if (typeof fn === 'function') fn(...args);
		}, ms);
		pending.add(id);
		return id;
	}) as TimeoutFn;

	const wrappedInterval: IntervalFn = ((
		fn: (...a: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		const id = realSetInterval(() => {
			if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
		}, ms);
		pending.add(id);
		return id;
	}) as IntervalFn;

	globalThis.setTimeout = wrappedTimeout;
	globalThis.clearTimeout = ((id: unknown) => {
		pending.delete(id);
		realClearTimeout(id as NodeJS.Timeout);
	}) as typeof clearTimeout;
	globalThis.setInterval = wrappedInterval;
	globalThis.clearInterval = ((id: unknown) => {
		pending.delete(id);
		realClearInterval(id as NodeJS.Timeout);
	}) as typeof clearInterval;

	return {
		pending: () => pending.size,
		assertIdle() {
			if (pending.size > 0) {
				throw new Error(`pending timers during idle window: ${pending.size}`);
			}
		},
		restore() {
			globalThis.setTimeout = realSetTimeout as TimeoutFn;
			globalThis.clearTimeout = realClearTimeout as typeof clearTimeout;
			globalThis.setInterval = realSetInterval as IntervalFn;
			globalThis.clearInterval = realClearInterval as typeof clearInterval;
			pending.clear();
		},
	};
}
