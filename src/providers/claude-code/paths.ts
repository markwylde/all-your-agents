import { homedir } from 'node:os';
import { join } from 'node:path';

export type PathOptions = {
	home?: string;
	env?: Record<string, string | undefined>;
	homedir?: string;
};

export function claudeHome(opts: PathOptions = {}): string {
	if (opts.home) return opts.home;
	const env = opts.env ?? process.env;
	if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
	return join(opts.homedir ?? homedir(), '.claude');
}

export function encodeProjectDir(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function sessionsDir(home: string): string {
	return join(home, 'sessions');
}

export function projectsDir(home: string): string {
	return join(home, 'projects');
}

export function derivedJournalPath(home: string, cwd: string, sessionId: string): string {
	return join(projectsDir(home), encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

export function subagentsDir(journalPath: string): string {
	return journalPath.replace(/\.jsonl$/, '');
}
