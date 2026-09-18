import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivedSessionDir, encodeCwd, grokHome } from '../../../src/providers/grok-build/paths.js';

test('cwd encoding matches Rust urlencoding, not encodeURIComponent', () => {
	assert.equal(encodeCwd('/Users/me/app'), '%2FUsers%2Fme%2Fapp');
	assert.equal(encodeCwd('/tmp/foo(bar)!'), '%2Ftmp%2Ffoo%28bar%29%21');
	assert.equal(encodeCwd("/a*b'c"), '%2Fa%2Ab%27c');
	assert.equal(encodeCwd('/x/a-b_c.d~e'), '%2Fx%2Fa-b_c.d~e');
	assert.equal(encodeCwd('/é'), '%2F%C3%A9');
});

test('home from option, then GROK_HOME, then ~/.grok', () => {
	assert.equal(grokHome({ home: '/custom', env: { GROK_HOME: '/env' } }), '/custom');
	assert.equal(grokHome({ env: { GROK_HOME: '/env' } }), '/env');
	assert.equal(grokHome({ env: {}, homedir: '/Users/me' }), '/Users/me/.grok');
});

test('derived session dir, and none when the encoded cwd is too long', () => {
	assert.equal(
		derivedSessionDir('/h', '/Users/me/app', 'id'),
		'/h/sessions/%2FUsers%2Fme%2Fapp/id',
	);
	const long = `/${'a'.repeat(260)}`;
	assert.equal(derivedSessionDir('/h', long, 'id'), undefined);
	// 85 slashes encode to 255 bytes exactly: still the URL form.
	assert.ok(derivedSessionDir('/h', '/'.repeat(85), 'id'));
	assert.equal(derivedSessionDir('/h', '/'.repeat(86), 'id'), undefined);
});
