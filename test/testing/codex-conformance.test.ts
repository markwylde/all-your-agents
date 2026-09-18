import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { codexCli } from '../../src/providers/codex-cli/index.js';
import { createCodexFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-codex-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

const driver = createCodexFixtureDriver(home);
defineConformanceTests({
	name: 'codex-cli',
	provider: codexCli({ home }),
	driver,
	processes: driver.processes,
});
