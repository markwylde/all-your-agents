import { systemClock } from './clock.ts';
import type { Clock } from './types.ts';

export type Coalescer = {
	notify(path: string, service: () => void): void;
	pending(): number;
	dispose(): void;
};

type Entry = {
	timer: unknown;
	firstPendingAt: number;
	service: () => void;
};

export function coalesce(quietMs = 25, maxLatencyMs = 1000, clock: Clock = systemClock): Coalescer {
	const pending = new Map<string, Entry>();

	const fire = (path: string): void => {
		const entry = pending.get(path);
		if (!entry) return;
		pending.delete(path);
		entry.service();
	};

	const arm = (path: string, entry: Entry): void => {
		const elapsed = clock.now() - entry.firstPendingAt;
		const wait = Math.min(quietMs, Math.max(0, maxLatencyMs - elapsed));
		entry.timer = clock.setTimeout(() => fire(path), wait);
	};

	return {
		notify(path, service) {
			const existing = pending.get(path);
			if (existing) {
				clock.clearTimeout(existing.timer);
				existing.service = service;
				arm(path, existing);
				return;
			}
			const entry: Entry = {
				timer: undefined,
				firstPendingAt: clock.now(),
				service,
			};
			pending.set(path, entry);
			arm(path, entry);
		},
		pending: () => pending.size,
		dispose() {
			for (const entry of pending.values()) {
				clock.clearTimeout(entry.timer);
			}
			pending.clear();
		},
	};
}
