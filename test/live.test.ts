import { test } from 'node:test';

test('live smoke moved to test/e2e', async (t) => {
	t.skip('run AYA_LIVE=1 npm test — e2e lives in test/e2e/');
});
