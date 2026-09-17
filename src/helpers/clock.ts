import type { Clock } from './types.js';

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => {
		clearTimeout(id as NodeJS.Timeout);
	},
};

export class FakeClock implements Clock {
	nowMs = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; fn: () => void }>();

	now(): number {
		return this.nowMs;
	}

	setTimeout(fn: () => void, ms: number): number {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
		return id;
	}

	clearTimeout(id: unknown): void {
		this.timers.delete(id as number);
	}

	pending(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			let next: { id: number; at: number; fn: () => void } | undefined;
			for (const [id, timer] of this.timers) {
				if (
					timer.at <= target &&
					(!next || timer.at < next.at || (timer.at === next.at && id < next.id))
				) {
					next = { id, at: timer.at, fn: timer.fn };
				}
			}
			if (!next) {
				this.nowMs = target;
				return;
			}
			this.nowMs = next.at;
			this.timers.delete(next.id);
			next.fn();
		}
	}
}
