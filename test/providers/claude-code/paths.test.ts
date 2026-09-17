import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	claudeHome,
	derivedJournalPath,
	encodeProjectDir,
} from '../../../src/providers/claude-code/paths.js';

test('encoding replaces every non-alphanumeric with -', () => {
	assert.equal(
		encodeProjectDir('/Users/me/app/.claude/worktrees/x'),
		'-Users-me-app--claude-worktrees-x',
	);
	assert.equal(encodeProjectDir('/Users/you/app'), '-Users-you-app');
});

test('home: option, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
	assert.equal(claudeHome({ home: '/tmp/h' }), '/tmp/h');
	assert.equal(claudeHome({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, homedir: '/Users/me' }), '/cfg');
	assert.equal(claudeHome({ env: {}, homedir: '/Users/me' }), '/Users/me/.claude');
});

test('derived journal path', () => {
	assert.equal(
		derivedJournalPath('/home/.claude', '/a/b', 'id-1'),
		'/home/.claude/projects/-a-b/id-1.jsonl',
	);
});
