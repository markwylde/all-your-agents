import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { antigravityCli } from '../../src/providers/antigravity-cli/index.js';
import { createAntigravityFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-agy-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

const driver = createAntigravityFixtureDriver(home, { settleMs: 80 });
defineConformanceTests({
	name: 'antigravity-cli',
	provider: antigravityCli({ home }),
	driver,
	processes: driver.processes,
});
