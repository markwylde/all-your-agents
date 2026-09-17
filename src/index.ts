import type { AllYourAgents as Instance } from './core/instance.js';
import { createAllYourAgents } from './core/instance.js';
import type { InstanceOptions } from './provider.js';
import { claudeCode } from './providers/claude-code/index.js';

export const builtInProviders = [claudeCode()];

export function AllYourAgents(opts: InstanceOptions = {}): Instance {
	return createAllYourAgents({
		...opts,
		providers: opts.providers ?? builtInProviders,
	});
}

export { claudeCode };

export default AllYourAgents;

export { emptyActivity, reduceActivity } from './core/activity.js';
export type { AllYourAgents as AllYourAgentsInstance } from './core/instance.js';
export { groupTurns } from './core/turns.js';
export {
	coalesce,
	createLocalFs,
	createLocalProcesses,
	tailJsonl,
	watchDir,
	watchFile,
} from './helpers/index.js';
export type { Clock, DebounceOptions, Fs, Processes } from './helpers/types.js';
export type {
	InspectContext,
	InstanceOptions,
	ListContext,
	Provider,
	SessionInput,
	Unwatch,
	WatchContext,
} from './provider.js';
export type {
	EventMeta,
	Harness,
	ProviderError,
	Session,
	SessionActivity,
	SessionEvent,
	SessionFilter,
	SessionKind,
	SessionSnapshot,
	SessionStatus,
	Subagent,
	SubagentFacts,
	SubagentStatus,
	TitleSource,
	Turn,
	TurnFact,
	TurnOutcome,
} from './types.js';
