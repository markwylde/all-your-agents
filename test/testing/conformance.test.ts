import { defineConformanceTests } from '../../src/testing/index.js';
import { createMemoryHarness } from '../../src/testing/memory.js';

const mem = createMemoryHarness();
defineConformanceTests({
	name: 'memory',
	provider: mem.provider,
	driver: mem.driver,
});
