// tests/slug-resolver.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.
//
// rename-wikilink.test.mjs and lint.test.mjs already pin the extracted
// behavior through the CLI (spawned rename.mjs / lint.mjs processes). These
// tests exercise scripts/lib/slug-resolver.mjs directly, in-process, so a
// future consumer (e.g. an OKF export walker) has its own contract to build
// against instead of only an indirect CLI guarantee.

import assert from 'node:assert/strict';
import { realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSlugMap,
  buildFormIndex,
  classifyTarget,
  newTargetFor,
  dirRelForm,
  maskNonWikilinkRegions,
  splitLinkBody,
  preservationClass,
  isPreservedSource,
  realContainedInVault,
} from '../scripts/lib/slug-resolver.mjs';
import { test, suite } from './harness.mjs';
import { withTmpDir } from './helpers.mjs';

suite('slug-resolver.mjs');

test('existence-check mode: buildSlugMap adds full/bare/dir-relative forms plus verbatim extraTargets', () => {
  const pages = [{ rel: 'pages/learnings/foo.md' }];
  const map = buildSlugMap(pages, ['sources/bar']);
  assert.ok(map.has('pages/learnings/foo'), 'full slug');
  assert.ok(map.has('foo'), 'bare basename');
  assert.ok(map.has('learnings/foo'), 'dir-relative alias');
  assert.ok(map.has('sources/bar'), 'extraTarget kept verbatim');
  // extraTargets get no derived aliases (a bare form could mask a real broken link).
  assert.ok(!map.has('bar'), 'extraTarget must not gain a derived bare alias');
});

test('collision-aware owner mode: a bare form shared by two pages is reported ambiguous, the unique dir-relative form is not', () => {
  const pages = [
    { rel: 'pages/x/foo.md', slug: 'pages/x/foo', bare: 'foo' },
    { rel: 'pages/y/foo.md', slug: 'pages/y/foo', bare: 'foo' },
  ];
  const formIndex = buildFormIndex(pages);
  const fromPage = pages[0];
  const toPage = { rel: 'pages/x/baz.md', slug: 'pages/x/baz', bare: 'baz' };

  const bare = classifyTarget('foo', fromPage, formIndex);
  assert.equal(bare.kind, 'bare');
  assert.equal(bare.ambiguous, true, 'bare form shared by two pages must be ambiguous');

  const dirRel = classifyTarget(dirRelForm(fromPage.slug), fromPage, formIndex);
  assert.equal(dirRel.kind, 'dirrel');
  assert.equal(dirRel.ambiguous, false, 'dir-relative form is unique, safe to rewrite');
  assert.equal(newTargetFor(dirRel.kind, toPage), 'x/baz');
});

test('collision-aware owner mode: sources/* pages get no bare/dir-relative alias in the form index', () => {
  const pages = [{ rel: 'sources/report.md', slug: 'sources/report', bare: 'report' }];
  const formIndex = buildFormIndex(pages);
  assert.ok(formIndex.has('sources/report'), 'full slug indexed');
  assert.ok(!formIndex.has('report'), 'bare basename must not resolve to a source');
});

test('maskNonWikilinkRegions blanks a fenced code block without changing length', () => {
  const content = 'see [[a]]\n```\n[[b]]\n```\nsee [[c]]';
  const masked = maskNonWikilinkRegions(content);
  assert.equal(masked.length, content.length, 'masking must preserve length for index alignment');
  assert.ok(masked.includes('[[a]]') && masked.includes('[[c]]'), 'real links survive masking');
  assert.ok(!masked.includes('[[b]]'), 'fenced link is blanked');
});

test('splitLinkBody separates target from alias/anchor suffix', () => {
  assert.deepEqual(splitLinkBody('foo|alias text'), { target: 'foo', suffix: '|alias text' });
  assert.deepEqual(splitLinkBody('foo#sec'), { target: 'foo', suffix: '#sec' });
  assert.deepEqual(splitLinkBody('foo'), { target: 'foo', suffix: '' });
});

test('preservationClass / isPreservedSource classify time records and immutable sources', () => {
  assert.equal(preservationClass('journal/2026-01-01.md'), 'timerecord');
  assert.equal(preservationClass('log.md'), 'timerecord');
  assert.equal(preservationClass('sources/report.md'), 'sources');
  assert.equal(preservationClass('pages/foo.md'), null);
  assert.equal(isPreservedSource('journal/2026-01-01.md'), true);
  assert.equal(isPreservedSource('pages/foo.md'), false);
});

test('realContainedInVault accepts an in-vault path and rejects a symlink escape', () => {
  withTmpDir((vault) => {
    withTmpDir((outside) => {
      const realRoot = realpathSync(vault);
      assert.equal(
        realContainedInVault(join(vault, 'pages', 'foo.md'), realRoot),
        true,
        'an ordinary in-vault path is contained',
      );
      const link = join(vault, 'escape');
      symlinkSync(outside, link);
      assert.equal(
        realContainedInVault(join(link, 'new.md'), realRoot),
        false,
        'a symlinked ancestor pointing outside the vault must not be contained',
      );
    });
  });
});
