export type FixtureDriver = {
	createLiveSession(opts: {
		id: string;
		pid: number;
		cwd?: string;
		status?: string;
		title?: string;
	}): Promise<void>;
	rewriteStatus(id: string, status: string): Promise<void>;
	switchConversation(pid: number, newId: string): Promise<void>;
	updateMetadata(id: string, patch: { cwd?: string; title?: string }): Promise<void>;
	remove(id: string): Promise<void>;
	addJournal(id: string, records: unknown[]): Promise<void>;
	runTurnWithTool(id: string): Promise<void>;
	failTurn(id: string): Promise<void>;
	launchForegroundSubagent(id: string): Promise<{ subagentId: string }>;
	finishForegroundSubagent(id: string, subagentId: string): Promise<void>;
	launchBackgroundSubagent(id: string): Promise<{ subagentId: string }>;
	finishBackgroundSubagent(id: string, subagentId: string): Promise<void>;
	launchNestedSubagent(id: string, parentSubagentId: string): Promise<{ subagentId: string }>;
	relocateJournal(id: string, newCwd: string): Promise<void>;
	/**
	 * Ends the open turn with a background shell command still running, one the harness
	 * will wake the session for. Absent when the harness records no such work.
	 */
	startBackgroundWait?(id: string): Promise<void>;
	/** That command ends without waking the session. */
	endBackgroundWait?(id: string): Promise<void>;
};
