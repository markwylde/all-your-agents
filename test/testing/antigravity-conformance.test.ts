import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLocalSqlite } from '../../src/helpers/sqlite.js';
import { antigravityCli } from '../../src/providers/antigravity-cli/index.js';
import { createAntigravityFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-agy-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

const driver = createAntigravityFixtureDriver(home, { settleMs: 80 });
// The driver writes, and the provider reads, through the runtime's built-in SQLite.
if (await createLocalSqlite())
	defineConformanceTests({
		name: 'antigravity-cli',
		provider: antigravityCli({ home }),
		driver,
		processes: driver.processes,
	});
else test('antigravity-cli conformance', { skip: 'this Node has no built-in SQLite' }, () => {});
