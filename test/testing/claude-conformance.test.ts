import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { claudeCode } from '../../src/providers/claude-code/index.js';
import { createClaudeFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-claude-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

defineConformanceTests({
	name: 'claude-code',
	provider: claudeCode({ home }),
	driver: createClaudeFixtureDriver(home, undefined, { settleMs: 80 }),
});
