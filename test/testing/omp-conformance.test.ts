import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { ohMyPi } from '../../src/providers/oh-my-pi/index.js';
import { createOmpFixtureDriver, defineConformanceTests } from '../../src/testing/index.js';

const home = mkdtempSync(join(tmpdir(), 'aya-omp-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

const driver = createOmpFixtureDriver(home);
defineConformanceTests({
	name: 'oh-my-pi',
	provider: ohMyPi({ home }),
	driver,
	processes: driver.processes,
});
