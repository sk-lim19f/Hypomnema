// tests/capture.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { test, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SCRIPTS,
  buildHookCommand,
  deriveCoreHookBasenames,
  isCaptureCandidate,
  isContainedUnder,
  isValidInstallStem,
  isValidSkillDirSegment,
  normalizeSkillRelPath,
  parseCapturableHookCommand,
  parseExtKey,
  parseSkillKey,
  parseSkillShaValue,
  planCapture,
  readCoreHooksConfig,
  resolveInstallFile,
  run,
  runWithHome,
  scanHookCandidates,
  scanSettingsHooks,
  withTmpDir,
  withTmpHome,
  writeExt,
} from './helpers.mjs';

suite('capture: isValidInstallStem (ADR 0061 §5)');

test('accepts a plain user name', () => {
  assert.ok(isValidInstallStem('mycmd'));
  assert.ok(isValidInstallStem('my-cmd.v2'));
});

test('rejects the reserved hypo namespace case-insensitively', () => {
  assert.ok(!isValidInstallStem('hypo'));
  assert.ok(!isValidInstallStem('hypo-foo'));
  assert.ok(!isValidInstallStem('Hypo-foo'));
  assert.ok(!isValidInstallStem('HYPO-foo'));
});

test('rejects Windows reserved device stems, including dot-suffixed, case-insensitively', () => {
  assert.ok(!isValidInstallStem('con'));
  assert.ok(!isValidInstallStem('CON'));
  assert.ok(!isValidInstallStem('com1'));
  assert.ok(!isValidInstallStem('LPT9'));
  assert.ok(!isValidInstallStem('con.v1')); // reserved even with an extension
  assert.ok(!isValidInstallStem('AUX.backup'));
  assert.ok(isValidInstallStem('com0')); // not a real device
  assert.ok(isValidInstallStem('console')); // not a device name
});

test('rejects path separators, traversal (leading and internal), leading dot, empty', () => {
  assert.ok(!isValidInstallStem('a/b'));
  assert.ok(!isValidInstallStem('a\\b'));
  assert.ok(!isValidInstallStem('..'));
  assert.ok(!isValidInstallStem('a..b')); // internal traversal must match parseExtKey
  assert.ok(!isValidInstallStem('.hidden'));
  assert.ok(!isValidInstallStem(''));
  assert.ok(!isValidInstallStem(42));
});

suite('capture: resolveInstallFile (ADR 0061 §3 installName decoupling)');

// Build a discovered-ext shape with a real on-disk manifest for parseManifest.
function extWithManifest(dir, type, file, manifest) {
  const stem = file.replace(/\.[^.]+$/, '');
  const manifestName = `${stem}.manifest.json`;
  let manifestPath = null;
  if (manifest !== undefined) {
    manifestPath = join(dir, manifestName);
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  return { type, name: stem, file, srcPath: join(dir, file), manifestName, manifestPath };
}

test('defaults to the wiki filename when no manifest (backward compatible)', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'commands', 'hypo-ext-legacy.md', undefined);
    assert.deepEqual(resolveInstallFile(ext), { installFile: 'hypo-ext-legacy.md' });
  });
});

test('honors installName when manifest.type matches the directory', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'commands', 'hypo-ext-new.md', {
      type: 'command',
      installName: 'newcmd',
    });
    assert.deepEqual(resolveInstallFile(ext), { installFile: 'newcmd.md' });
  });
});

test('ignores installName when manifest.type mismatches the directory', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'commands', 'hypo-ext-x.md', {
      type: 'agent',
      installName: 'x',
    });
    assert.deepEqual(resolveInstallFile(ext), { installFile: 'hypo-ext-x.md' });
  });
});

test('skips (not installs under wiki name) an invalid installName', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'commands', 'hypo-ext-bad.md', {
      type: 'command',
      installName: '../evil',
    });
    const res = resolveInstallFile(ext);
    assert.equal(res.skip, true);
    assert.ok(/invalid installName/.test(res.warn));
  });
});

test('hooks without installName keep the wiki name (wiki-authored, backward compatible)', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'hooks', 'hypo-ext-h.mjs', {
      type: 'hook',
      event: 'Stop',
    });
    assert.deepEqual(resolveInstallFile(ext), { installFile: 'hypo-ext-h.mjs' });
  });
});

test('hooks honor a valid installName from a hook manifest (installName decoupling)', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'hooks', 'hypo-ext-h.mjs', {
      type: 'hook',
      event: 'Stop',
      installName: 'myhook',
    });
    assert.deepEqual(resolveInstallFile(ext), { installFile: 'myhook.mjs' });
  });
});

test('hooks skip an invalid installName rather than install under the wiki name', () => {
  withTmpDir((dir) => {
    const ext = extWithManifest(dir, 'hooks', 'hypo-ext-h.mjs', {
      type: 'hook',
      event: 'Stop',
      installName: 'hypo-reserved',
    });
    const res = resolveInstallFile(ext);
    assert.equal(res.skip, true);
    assert.ok(/invalid installName/.test(res.warn));
  });
});

suite('capture: parseExtKey (ADR 0061 §8 uninstall key safety)');

const COVERED = ['hooks', 'commands', 'skills', 'agents'];

test('accepts a well-formed key', () => {
  assert.deepEqual(parseExtKey('commands/mycmd.md', COVERED), {
    type: 'commands',
    installFile: 'mycmd.md',
  });
});

test('rejects traversal / separators / wrong extension / unknown type', () => {
  assert.equal(parseExtKey('commands/../evil.md', COVERED), null);
  assert.equal(parseExtKey('commands/a/b.md', COVERED), null);
  assert.equal(parseExtKey('commands/a..b.md', COVERED), null);
  assert.equal(parseExtKey('commands/mycmd.txt', COVERED), null);
  assert.equal(parseExtKey('hooks/x.md', COVERED), null); // hooks want .mjs
  assert.equal(parseExtKey('unknown/x.md', COVERED), null);
  assert.equal(parseExtKey('commands/.hidden.md', COVERED), null);
  assert.equal(parseExtKey('nokey', COVERED), null);
  assert.equal(parseExtKey('commands/', COVERED), null);
});

test('accepts the hook manifest sidecar but only for hooks', () => {
  assert.deepEqual(parseExtKey('hooks/hypo-ext-x.manifest.json', COVERED), {
    type: 'hooks',
    installFile: 'hypo-ext-x.manifest.json',
  });
  // Only hooks record a manifest copy — a non-hook manifest key must not name a
  // removable file (widened destructive surface).
  assert.equal(parseExtKey('commands/x.manifest.json', COVERED), null);
  assert.equal(parseExtKey('agents/x.manifest.json', COVERED), null);
});

test('respects the covered-types scope (codex excludes skills/agents)', () => {
  assert.equal(parseExtKey('agents/x.md', ['hooks', 'commands']), null);
  assert.deepEqual(parseExtKey('commands/x.md', ['hooks', 'commands']), {
    type: 'commands',
    installFile: 'x.md',
  });
});

// ── directory skills: key + path validators (ADR 0063, T1) ──────────────

suite('skills-dir: isValidSkillDirSegment');

test('accepts a plain skill dir name, rejects the flat installName escapes', () => {
  assert.ok(isValidSkillDirSegment('gstack'));
  assert.ok(isValidSkillDirSegment('my-skill.v2'));
  assert.ok(!isValidSkillDirSegment('hypo'));
  assert.ok(!isValidSkillDirSegment('Hypo-x'));
  assert.ok(!isValidSkillDirSegment('con'));
  assert.ok(!isValidSkillDirSegment('COM1'));
  assert.ok(!isValidSkillDirSegment('a/b'));
  assert.ok(!isValidSkillDirSegment('a..b'));
  assert.ok(!isValidSkillDirSegment('.hidden'));
});

test('rejects a trailing dot (Windows strips it, so foo. aliases foo)', () => {
  assert.ok(!isValidSkillDirSegment('foo.'));
  assert.ok(isValidSkillDirSegment('foo.bar'));
});

suite('skills-dir: parseSkillKey (recorded pkg-json key)');

test('accepts skills/<safe-dir> only', () => {
  assert.deepEqual(parseSkillKey('skills/foo'), { type: 'skills', installDir: 'foo' });
  assert.equal(parseSkillKey('commands/foo.md'), null); // flat key is not a skill key
  assert.equal(parseSkillKey('skills/foo/SKILL.md'), null); // sub-path never a top-level key
  assert.equal(parseSkillKey('skills/../evil'), null);
  assert.equal(parseSkillKey('skills/hypo-x'), null);
  assert.equal(parseSkillKey('skills/'), null);
  assert.equal(parseSkillKey('skills'), null);
  assert.equal(parseSkillKey(42), null);
});

test('a skill key must not survive parseExtKey (the no-slash rule stays shut)', () => {
  // The regression this guards: routing skills/foo through parseExtKey silently
  // drops the record in uninstall, stranding installed files we own.
  assert.equal(parseExtKey('skills/foo', ['skills']), null);
});

suite('skills-dir: normalizeSkillRelPath');

test('accepts canonical subtree paths', () => {
  assert.equal(normalizeSkillRelPath('SKILL.md'), 'SKILL.md');
  assert.equal(normalizeSkillRelPath('references/x.md'), 'references/x.md');
  assert.equal(normalizeSkillRelPath('a/b/c/d.txt'), 'a/b/c/d.txt');
});

test('rejects traversal, absolute, backslash, Windows drive/UNC, NUL', () => {
  assert.equal(normalizeSkillRelPath('../x.md'), null);
  assert.equal(normalizeSkillRelPath('references/../../x.md'), null);
  assert.equal(normalizeSkillRelPath('/etc/passwd'), null);
  assert.equal(normalizeSkillRelPath('refs\\x.md'), null);
  assert.equal(normalizeSkillRelPath('C:/x.md'), null);
  assert.equal(normalizeSkillRelPath('C:x.md'), null);
  assert.equal(normalizeSkillRelPath('//host/share/x.md'), null);
  assert.equal(normalizeSkillRelPath('a/\0b.md'), null);
});

test('rejects dot segments and empty segments (they alias a real destination)', () => {
  assert.equal(normalizeSkillRelPath('references/./x.md'), null);
  assert.equal(normalizeSkillRelPath('./x.md'), null);
  assert.equal(normalizeSkillRelPath('a//b.md'), null);
  assert.equal(normalizeSkillRelPath(''), null);
});

test('rejects a trailing-dot segment and a pathological depth/length', () => {
  assert.equal(normalizeSkillRelPath('refs./x.md'), null);
  assert.equal(normalizeSkillRelPath(Array(20).fill('a').join('/') + '/x.md'), null);
  assert.equal(normalizeSkillRelPath('a/' + 'x'.repeat(500) + '.md'), null);
});

suite('skills-dir: isContainedUnder (boundary-aware, not startsWith)');

test('a sibling whose name merely shares a prefix is NOT contained', () => {
  assert.ok(isContainedUnder('/a/b', '/a/b/c.md'));
  assert.ok(!isContainedUnder('/a/b', '/a/bc/c.md')); // raw startsWith would say yes
  assert.ok(!isContainedUnder('/a/b', '/a/b')); // the root itself is not "under" itself
  assert.ok(!isContainedUnder('/a/b', '/a/x.md'));
});

suite('skills-dir: parseSkillShaValue (corrupt pkg-json cannot be trusted)');

test('keeps only canonical relpaths mapped to hex SHAs', () => {
  const good = 'a'.repeat(64);
  // The returned map is null-prototype (a relpath may legitimately be `__proto__`),
  // so compare own entries rather than deep-equal against a plain object literal.
  assert.deepEqual(Object.entries(parseSkillShaValue({ 'SKILL.md': good })), [['SKILL.md', good]]);
  // dropped: non-hex, wrong length, non-string, traversal key, non-canonical key
  assert.deepEqual(
    Object.entries(
      parseSkillShaValue({
        'SKILL.md': good,
        'bad.md': 'nothex',
        'short.md': 'abc',
        'obj.md': { nested: 1 },
        '../escape.md': good,
        'refs/./x.md': good,
      }),
    ),
    [['SKILL.md', good]],
  );
});

test('a shape mismatch (string SHA under a skill key) yields null, not a crash', () => {
  assert.equal(parseSkillShaValue('a'.repeat(64)), null);
  assert.equal(parseSkillShaValue(null), null);
  assert.equal(parseSkillShaValue(['a']), null);
});

suite('capture: isCaptureCandidate + planCapture (ADR 0061 §6/§7)');

test('candidate filter excludes hypo-*, non-.md, and already-owned', () => {
  assert.ok(isCaptureCandidate('commands', 'mycmd.md', {}).ok);
  assert.ok(!isCaptureCandidate('commands', 'hypo-core.md', {}).ok);
  assert.ok(!isCaptureCandidate('commands', 'Hypo-core.md', {}).ok);
  assert.ok(!isCaptureCandidate('commands', 'readme.txt', {}).ok);
  assert.ok(!isCaptureCandidate('commands', 'owned.md', { 'commands/owned.md': 'sha' }).ok);
});

test('planCapture: ready when no wiki file exists', () => {
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: null,
    existingManifestRaw: null,
  });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.manifest, { type: 'command', installName: 'x' });
});

test('planCapture: invalid stem', () => {
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'hypo-x' },
    srcSha: 'A',
    existingFileSha: null,
    existingManifestRaw: null,
  });
  assert.equal(p.status, 'invalid');
});

test('planCapture: conflict when wiki file differs', () => {
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: 'B',
    existingManifestRaw: null,
  });
  assert.equal(p.status, 'conflict');
});

test('planCapture: conflict when file matches but manifest missing', () => {
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: 'A',
    existingManifestRaw: null,
  });
  assert.equal(p.status, 'conflict');
});

test('planCapture: conflict when manifest declares a different mapping', () => {
  const raw = JSON.stringify({ type: 'command', installName: 'other' });
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: 'A',
    existingManifestRaw: raw,
  });
  assert.equal(p.status, 'conflict');
});

test('planCapture: already when file + manifest both match (deep-equal, order-independent)', () => {
  // Keys are deliberately reordered vs the want-manifest to prove deep-equality is
  // not key-order sensitive.
  const raw = JSON.stringify({ installName: 'x', type: 'command' });
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: 'A',
    existingManifestRaw: raw,
  });
  assert.equal(p.status, 'already');
});

test('planCapture: already for a full hook manifest (deep-equal of event/matcher/timeout)', () => {
  const want = {
    type: 'hook',
    installName: 'h',
    event: 'PostToolUse',
    matcher: 'Write|Edit',
    timeout: 5000,
  };
  const raw = JSON.stringify({
    event: 'PostToolUse',
    installName: 'h',
    timeout: 5000,
    type: 'hook',
    matcher: 'Write|Edit',
  });
  const p = planCapture({
    wantManifest: want,
    srcSha: 'A',
    existingFileSha: 'A',
    existingManifestRaw: raw,
  });
  assert.equal(p.status, 'already');
});

test('planCapture: conflict when a hook manifest differs by one field', () => {
  const want = { type: 'hook', installName: 'h', event: 'PostToolUse', timeout: 5000 };
  const raw = JSON.stringify({
    type: 'hook',
    installName: 'h',
    event: 'PostToolUse',
    timeout: 9999,
  });
  const p = planCapture({
    wantManifest: want,
    srcSha: 'A',
    existingFileSha: 'A',
    existingManifestRaw: raw,
  });
  assert.equal(p.status, 'conflict');
});

test('planCapture: conflict on a stray manifest with a different mapping', () => {
  const raw = JSON.stringify({ type: 'command', installName: 'other' });
  const p = planCapture({
    wantManifest: { type: 'command', installName: 'x' },
    srcSha: 'A',
    existingFileSha: null,
    existingManifestRaw: raw,
  });
  assert.equal(p.status, 'conflict');
});

suite('capture: forward-sync installFile integration (backward compat + adopt)');

test('installName-less command installs under the wiki name (no regression)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      writeExt(hypoDir, 'commands', 'hypo-ext-legacy.md', '# legacy\n');
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(home, '.claude', 'commands', 'hypo-ext-legacy.md')));
    });
  });
});

test('installName manifest installs under the original name', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      writeExt(hypoDir, 'commands', 'hypo-ext-new.md', '# new\n', {
        type: 'command',
        installName: 'newcmd',
      });
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        existsSync(join(home, '.claude', 'commands', 'newcmd.md')),
        'installed under installName',
      );
      assert.ok(
        !existsSync(join(home, '.claude', 'commands', 'hypo-ext-new.md')),
        'wiki storage name NOT installed',
      );
    });
  });
});

// P1/F1: a hook manifest with a valid installName installs the `.mjs`, its sidecar
// manifest, and its settings.json command all under the ORIGINAL name, and both SHA
// keys are owned. Success criterion (d) checks the SHA KEY, not just disk presence.
test('installName hook installs mjs, sidecar, and command under the original name', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      writeExt(hypoDir, 'hooks', 'hypo-ext-h.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 10000,
        installName: 'myhook',
      });
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, r.stderr);

      const copyDir = join(home, '.claude', 'hooks');
      // (1) `.mjs` and sidecar install under the original name; wiki names are not.
      assert.ok(existsSync(join(copyDir, 'myhook.mjs')), 'hook not installed under installName');
      assert.ok(
        existsSync(join(copyDir, 'myhook.manifest.json')),
        'sidecar not installed under installName (P1)',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-h.mjs')),
        'wiki storage name .mjs must NOT be installed',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-h.manifest.json')),
        'wiki storage name sidecar must NOT be installed (P1)',
      );

      // (2) settings.json command is reconstructed under the original name.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const groups = (settings.hooks?.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('myhook.mjs')),
      );
      assert.equal(groups.length, 1, 'exactly one PostToolUse entry expected');
      assert.equal(
        groups[0].hooks[0].command,
        'node $HOME/.claude/hooks/myhook.mjs',
        'command must be reconstructed under installName',
      );
      assert.equal(groups[0].matcher, 'Write|Edit');
      assert.equal(groups[0].hooks[0].timeout, 10000);

      // (3) BOTH SHA keys are owned under the original name (success criterion d).
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['hooks/myhook.mjs'],
        'hook SHA key not owned under installName',
      );
      assert.ok(
        pkg.extensions.claude['hooks/myhook.manifest.json'],
        'sidecar SHA key not owned under installName (P1)',
      );
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-h.mjs'],
        'wiki-name hook SHA key must not be recorded',
      );
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-h.manifest.json'],
        'wiki-name sidecar SHA key must not be recorded',
      );
    });
  });
});

test('duplicate installName skips the whole group (no partial install)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      writeExt(hypoDir, 'commands', 'hypo-ext-a.md', '# a\n', {
        type: 'command',
        installName: 'dup',
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-b.md', '# b\n', {
        type: 'command',
        installName: 'dup',
      });
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        !existsSync(join(home, '.claude', 'commands', 'dup.md')),
        'no file installed on collision',
      );
    });
  });
});

test('a later duplicate does not orphan an already-owned installed file', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      // A owns commands/dup.md after the first sync.
      writeExt(hypoDir, 'commands', 'hypo-ext-a.md', '# a\n', {
        type: 'command',
        installName: 'dup',
      });
      assert.equal(
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home).status,
        0,
      );
      let pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(pkg.extensions.claude['commands/dup.md'], 'A owns dup.md after first sync');
      // Now a colliding B appears; the group is skipped but A's ownership record
      // must survive so the installed file is not orphaned.
      writeExt(hypoDir, 'commands', 'hypo-ext-b.md', '# b\n', {
        type: 'command',
        installName: 'dup',
      });
      assert.equal(
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home).status,
        0,
      );
      pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['commands/dup.md'],
        'ownership of the already-installed file is preserved on a later collision',
      );
    });
  });
});

// A hook records TWO ownership keys (the `.mjs` and its `.manifest.json` sidecar).
// When a later same-installName hook forces a duplicate-target skip, BOTH keys of
// the already-owned hook must be preserved; preserving only the `.mjs` (codex
// pre-commit CONCERN) would drop the sidecar SHA and leave the installed manifest
// copy untracked and unreachable by uninstall.
test('a later duplicate hook preserves BOTH the mjs and the sidecar ownership keys', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      // A owns hooks/dup.mjs + hooks/dup.manifest.json after the first sync.
      writeExt(hypoDir, 'hooks', 'hypo-ext-a.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'dup',
      });
      assert.equal(
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home).status,
        0,
      );
      let pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(pkg.extensions.claude['hooks/dup.mjs'], 'A owns dup.mjs after first sync');
      assert.ok(
        pkg.extensions.claude['hooks/dup.manifest.json'],
        'A owns dup.manifest.json after first sync',
      );
      // A colliding B appears; the group is skipped but A's ownership of BOTH keys
      // must survive so neither installed copy is orphaned.
      writeExt(hypoDir, 'hooks', 'hypo-ext-b.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'dup',
      });
      assert.equal(
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home).status,
        0,
      );
      pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['hooks/dup.mjs'],
        'mjs ownership preserved on a later collision',
      );
      assert.ok(
        pkg.extensions.claude['hooks/dup.manifest.json'],
        'sidecar ownership preserved on a later collision',
      );
    });
  });
});

test('capture refuses a wiki target that is a symlink (no follow, no overwrite)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'mycmd.md'), '# mine\n');
      // Plant a symlink at the wiki storage path pointing outside the wiki.
      const outside = join(dir, 'secret.txt');
      writeFileSync(outside, 'ORIGINAL SECRET\n');
      const wikiCmds = join(hypoDir, 'extensions', 'commands');
      mkdirSync(wikiCmds, { recursive: true });
      symlinkSync(outside, join(wikiCmds, 'hypo-ext-mycmd.md'));
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      // Refused as a conflict: the symlink is never followed or overwritten, and
      // nothing is adopted (no ownership recorded for the install path).
      assert.match(r.stdout, /not a regular file/);
      assert.equal(readFileSync(outside, 'utf-8'), 'ORIGINAL SECRET\n', 'symlink target untouched');
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const owned = existsSync(pkgPath)
        ? (JSON.parse(readFileSync(pkgPath, 'utf-8')).extensions?.claude ?? {})
        : {};
      assert.ok(!owned['commands/mycmd.md'], 'nothing adopted on conflict');
    });
  });
});

suite('capture: end-to-end adopt + uninstall by key');

test('capture --all adopts into wiki and records ownership under the install path', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'mycmd.md'), '# My Command\n');
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mycmd.md')));
      assert.ok(
        existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mycmd.manifest.json')),
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['commands/mycmd.md'],
        'ownership recorded under install path',
      );
    });
  });
});

test('uninstall --apply removes the captured install-path file and preserves unowned', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'mycmd.md'), '# owned\n');
      assert.equal(runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home).status, 0);
      writeFileSync(join(home, '.claude', 'commands', 'foreign.md'), '# foreign\n');
      const r = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(home, '.claude', 'commands', 'mycmd.md')), 'owned removed');
      assert.ok(existsSync(join(home, '.claude', 'commands', 'foreign.md')), 'unowned preserved');
    });
  });
});

// A partial adopt (forward-sync owns the byte-identical `.mjs` but cannot own its
// sidecar manifest because the install-path sidecar is a non-regular file) must NOT
// leave stray `.mjs` ownership recorded in hypo-pkg.json. Left behind, a later
// capture would skip the hook as already-managed and uninstall would trust the
// recorded SHA and delete the user's ORIGINAL hook (codex pre-commit CONCERN).
test('capture: partial hook adopt rolls back stray ownership, uninstall spares the original', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const hooksDir = join(home, '.claude', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      const original = '#!/usr/bin/env node\n// user hook\n';
      writeFileSync(join(hooksDir, 'myhook.mjs'), original);
      // Canonical settings registration so the hook is a capture candidate.
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/myhook.mjs' }] }],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      // Block sidecar adoption: a directory sits where the install-path sidecar
      // would go, so forward-sync's copyOne returns skip-non-regular (it does NOT
      // throw). The `.mjs` is byte-identical so its key IS recorded -> partial adopt.
      mkdirSync(join(hooksDir, 'myhook.manifest.json'), { recursive: true });

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 1, 'a partial adopt must report failure (exit 1)');

      // The install-path `.mjs` still exists byte-identical (proves sync reached the
      // up-to-date branch and the partial-adopt path, not the throw/catch rollback).
      assert.equal(
        readFileSync(join(hooksDir, 'myhook.mjs'), 'utf-8'),
        original,
        'user original untouched',
      );
      // No stray ownership left in the pkg map.
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const owned = existsSync(pkgPath)
        ? (JSON.parse(readFileSync(pkgPath, 'utf-8')).extensions?.claude ?? {})
        : {};
      assert.ok(!owned['hooks/myhook.mjs'], 'stray .mjs ownership must be rolled back');
      assert.ok(!owned['hooks/myhook.manifest.json'], 'sidecar was never owned');
      // Wiki files rolled back.
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-myhook.mjs')),
        'wiki storage file rolled back',
      );

      // Since nothing was adopted, uninstall must NOT delete the user's original.
      const u = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(u.status, 0, u.stderr);
      assert.ok(
        existsSync(join(hooksDir, 'myhook.mjs')),
        'uninstall must not delete the un-adopted original hook',
      );
    });
  });
});

// ── reverse hook capture: command builder + strict parser + settings scanner ──

suite('capture: buildHookCommand / parseCapturableHookCommand round-trip');

test('round-trip accept: a HOME-relative dir builds a command the parser restores', () => {
  const hooksDir = join(HOME, '.claude', 'hooks');
  for (const stem of ['mycmd', 'my-hook.v2', 'a_b.c']) {
    const command = buildHookCommand(hooksDir, `${stem}.mjs`);
    assert.equal(command, `node $HOME/.claude/hooks/${stem}.mjs`);
    const parsed = parseCapturableHookCommand(command);
    assert.ok(parsed.ok, `${stem} should round-trip`);
    assert.equal(parsed.stem, stem);
    assert.equal(parsed.basename, `${stem}.mjs`);
  }
});

test('round-trip reject: a dir outside HOME builds an absolute command the parser rejects', () => {
  withTmpDir((dir) => {
    // withTmpDir lives under tmpdir(), outside HOME — .replace(HOME,'$HOME') is a
    // no-op so the builder emits an absolute path the strict parser must refuse
    // (proves no silent accept of a non-canonical registration).
    const hooksDir = join(dir, 'hooks');
    const command = buildHookCommand(hooksDir, 'x.mjs');
    assert.ok(command.startsWith(`node ${hooksDir}/`), 'builder kept the absolute path');
    const parsed = parseCapturableHookCommand(command);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'path-not-under-home-hooks');
  });
});

suite('capture: parseCapturableHookCommand strict axes');

test('accepts the exact canonical form', () => {
  const parsed = parseCapturableHookCommand('node $HOME/.claude/hooks/mycmd.mjs');
  assert.deepEqual(parsed, { ok: true, stem: 'mycmd', basename: 'mycmd.mjs' });
});

test('rejects a non-string with a distinct reason', () => {
  assert.deepEqual(parseCapturableHookCommand(42), { ok: false, reason: 'not-a-string' });
  assert.deepEqual(parseCapturableHookCommand(null), { ok: false, reason: 'not-a-string' });
  assert.deepEqual(parseCapturableHookCommand(undefined), { ok: false, reason: 'not-a-string' });
});

test('rejects CR/LF', () => {
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/x.mjs\n').reason,
    'contains-newline',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/x.mjs\r').reason,
    'contains-newline',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/a\nb.mjs').reason,
    'contains-newline',
  );
});

test('rejects a bad node prefix, including double space and tab', () => {
  assert.equal(
    parseCapturableHookCommand('nodex $HOME/.claude/hooks/x.mjs').reason,
    'bad-node-prefix',
  );
  assert.equal(
    parseCapturableHookCommand('/usr/bin/node $HOME/.claude/hooks/x.mjs').reason,
    'bad-node-prefix',
  );
  assert.equal(
    parseCapturableHookCommand('node  $HOME/.claude/hooks/x.mjs').reason,
    'bad-node-prefix',
  ); // double space
  assert.equal(
    parseCapturableHookCommand('node\t$HOME/.claude/hooks/x.mjs').reason,
    'bad-node-prefix',
  ); // tab for space
  assert.equal(
    parseCapturableHookCommand('node \t$HOME/.claude/hooks/x.mjs').reason,
    'bad-node-prefix',
  ); // space then tab
  assert.equal(parseCapturableHookCommand('node ').reason, 'bad-node-prefix');
});

test('rejects a path not under $HOME/.claude/hooks (tilde, relative, env prefix, absolute)', () => {
  assert.equal(
    parseCapturableHookCommand('node ~/.claude/hooks/x.mjs').reason,
    'path-not-under-home-hooks',
  );
  assert.equal(
    parseCapturableHookCommand('node .claude/hooks/x.mjs').reason,
    'path-not-under-home-hooks',
  );
  assert.equal(parseCapturableHookCommand('node hooks/x.mjs').reason, 'path-not-under-home-hooks');
  assert.equal(
    parseCapturableHookCommand('node FOO=1 $HOME/.claude/hooks/x.mjs').reason,
    'path-not-under-home-hooks',
  );
  assert.equal(
    parseCapturableHookCommand('node /Users/foo/.claude/hooks/x.mjs').reason,
    'path-not-under-home-hooks',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/agents/x.mjs').reason,
    'path-not-under-home-hooks',
  );
});

test('rejects a nested segment or traversal in the tail', () => {
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/sub/x.mjs').reason,
    'nested-segment',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/../x.mjs').reason,
    'nested-segment',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/a..b.mjs').reason,
    'nested-segment',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/a\\b.mjs').reason,
    'nested-segment',
  );
});

test('rejects a non-.mjs tail', () => {
  assert.equal(parseCapturableHookCommand('node $HOME/.claude/hooks/x.js').reason, 'not-mjs');
  assert.equal(parseCapturableHookCommand('node $HOME/.claude/hooks/x').reason, 'not-mjs');
  assert.equal(parseCapturableHookCommand('node $HOME/.claude/hooks/x.mjs.bak').reason, 'not-mjs');
});

test('rejects a stem that fails isValidInstallStem, including the reserved hypo namespace', () => {
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/hypo-core.mjs').reason,
    'invalid-stem',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/Hypo-x.mjs').reason,
    'invalid-stem',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/con.mjs').reason,
    'invalid-stem',
  );
  assert.equal(
    parseCapturableHookCommand('node $HOME/.claude/hooks/.hidden.mjs').reason,
    'invalid-stem',
  );
  assert.equal(parseCapturableHookCommand('node $HOME/.claude/hooks/.mjs').reason, 'invalid-stem'); // empty stem
});

suite('capture: scanSettingsHooks defensive walk');

test('yields one record per hook with matcher attribution and event/group keys', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node $HOME/.claude/hooks/a.mjs', timeout: 5 },
            { type: 'command', command: 'node $HOME/.claude/hooks/b.mjs' },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/c.mjs' }] }],
    },
  };
  const records = scanSettingsHooks(settings);
  assert.equal(records.length, 3);
  const a = records.find((r) => r.command.endsWith('a.mjs'));
  assert.equal(a.event, 'PreToolUse');
  assert.equal(a.matcher, 'Bash');
  assert.equal(a.timeout, 5);
  assert.deepEqual(a.hookKeys, ['type', 'command', 'timeout']);
  assert.deepEqual(a.groupKeys, ['matcher', 'hooks']);
  const b = records.find((r) => r.command.endsWith('b.mjs'));
  assert.equal(b.matcher, 'Bash'); // attributed verbatim from the shared parent group
  assert.equal(b.timeout, undefined);
  const c = records.find((r) => r.command.endsWith('c.mjs'));
  assert.equal(c.event, 'Stop');
  assert.equal(c.matcher, undefined); // no matcher on the group
});

test('normalizes an empty-string matcher to absent', () => {
  const records = scanSettingsHooks({
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/x.mjs' }] },
      ],
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].matcher, undefined);
});

test('skips malformed rungs without throwing', () => {
  assert.deepEqual(scanSettingsHooks(null), []);
  assert.deepEqual(scanSettingsHooks(42), []);
  assert.deepEqual(scanSettingsHooks({}), []);
  assert.deepEqual(scanSettingsHooks({ hooks: [] }), []); // hooks must be an object map
  assert.deepEqual(scanSettingsHooks({ hooks: { Stop: {} } }), []); // event value must be an array
  assert.deepEqual(scanSettingsHooks({ hooks: { Stop: ['notgroup'] } }), []); // group must be an object
  assert.deepEqual(scanSettingsHooks({ hooks: { Stop: [{ hooks: 'x' }] } }), []); // hook list must be an array
  assert.deepEqual(scanSettingsHooks({ hooks: { Stop: [{ hooks: ['notobj', null, 42] }] } }), []); // hook entries must be objects
});

test('surfaces the raw entry.type value (needed for the command-type gate)', () => {
  const records = scanSettingsHooks({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/x.mjs' }] }],
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'command');
});

// ── reverse hook capture: scanHookCandidates (T4, F3/F4/F6 + exclusions) ───────

// Build a throwaway ~/.claude with a hooks/ dir + settings.json for the pure
// scanHookCandidates walk. `hookFiles` are created as real regular .mjs sources so
// the resolved-source existence check passes; omit a name to exercise a missing
// source. Returns via callback so the temp dir is cleaned up.
function withHookEnv(hookFiles, settings, fn) {
  withTmpDir((dir) => {
    const claudeHome = join(dir, '.claude');
    const hooksDir = join(claudeHome, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    for (const name of hookFiles) writeFileSync(join(hooksDir, name), '#!/usr/bin/env node\n');
    const settingsPath = join(claudeHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    fn({ claudeHome, settingsPath });
  });
}

function oneHook(command, extra = {}) {
  return { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command, ...extra }] }] } };
}

suite('capture: scanHookCandidates candidate + exclusions (T4)');

test('a canonical hook with a real source becomes a candidate with restored fields', () => {
  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/goodh.mjs', timeout: 5 }],
        },
      ],
    },
  };
  withHookEnv(['goodh.mjs'], settings, ({ claudeHome, settingsPath }) => {
    const { candidates, skipped } = scanHookCandidates(claudeHome, settingsPath, {}, new Set());
    assert.equal(candidates.length, 1);
    assert.equal(skipped.length, 0);
    const c = candidates[0];
    assert.equal(c.type, 'hooks');
    assert.equal(c.stem, 'goodh');
    assert.equal(c.file, 'goodh.mjs');
    assert.equal(c.event, 'PostToolUse');
    assert.equal(c.matcher, 'Write');
    assert.equal(c.timeout, 5);
    assert.equal(c.label, 'hooks/goodh.mjs');
  });
});

test('no-ops cleanly on an absent or invalid settings.json (keeps commands/agents green)', () => {
  withTmpDir((dir) => {
    const claudeHome = join(dir, '.claude');
    mkdirSync(claudeHome, { recursive: true });
    const missing = join(claudeHome, 'settings.json');
    assert.deepEqual(scanHookCandidates(claudeHome, missing, {}, new Set()), {
      candidates: [],
      skipped: [],
    });
    writeFileSync(missing, '{ not json');
    assert.deepEqual(scanHookCandidates(claudeHome, missing, {}, new Set()), {
      candidates: [],
      skipped: [],
    });
  });
});

test('lossy command axes each skip with a visible reason and yield no candidate', () => {
  // Each axis uses a UNIQUE basename so the F6 duplicate check never shadows the
  // per-axis reason. None of these is capturable, so nothing is written anywhere.
  const axes = [
    { command: 'node $HOME/.claude/hooks/argh.mjs --flag', reason: 'not-mjs' }, // extra CLI arg
    { command: 'FOO=1 node $HOME/.claude/hooks/envh.mjs', reason: 'bad-node-prefix' }, // env prefix
    { command: 'node $HOME/.claude/hooks/shellh.mjs && echo hi', reason: 'not-mjs' }, // inline shell
    { command: '/usr/bin/node $HOME/.claude/hooks/absnodeh.mjs', reason: 'bad-node-prefix' }, // non-bare node
    { command: 'node $HOME/.claude/hooks/ghosth.mjs', reason: 'unresolved-source' }, // .mjs missing
    { command: 'node $HOME/.config/hooks/outh.mjs', reason: 'path-not-under-home-hooks' }, // path outside
    { command: 'node hooks/relh.mjs', reason: 'path-not-under-home-hooks' }, // relative
    { command: 'node ~/.claude/hooks/tildeh.mjs', reason: 'path-not-under-home-hooks' }, // tilde
    { command: 'node  $HOME/.claude/hooks/dblh.mjs', reason: 'bad-node-prefix' }, // double space
    { command: 'node $HOME/.claude/hooks/crh.mjs\n', reason: 'contains-newline' }, // CRLF
  ];
  const settings = {
    hooks: { PostToolUse: axes.map((a) => ({ hooks: [{ type: 'command', command: a.command }] })) },
  };
  // Deliberately do NOT create ghosth.mjs (unresolved-source axis).
  withHookEnv([], settings, ({ claudeHome, settingsPath }) => {
    const { candidates, skipped } = scanHookCandidates(claudeHome, settingsPath, {}, new Set());
    assert.equal(candidates.length, 0, 'no lossy command becomes a candidate');
    for (const a of axes) {
      assert.ok(
        skipped.some((s) => s.command === a.command && s.reason === a.reason),
        `${JSON.stringify(a.command)} should skip as ${a.reason}`,
      );
    }
  });
});

test('F3: an extra hook key skips as unpreservable-shape', () => {
  withHookEnv(
    ['shapeh.mjs'],
    oneHook('node $HOME/.claude/hooks/shapeh.mjs', { run: 'x' }),
    (env) => {
      const { candidates, skipped } = scanHookCandidates(
        env.claudeHome,
        env.settingsPath,
        {},
        new Set(),
      );
      assert.equal(candidates.length, 0);
      assert.ok(skipped.some((s) => s.reason === 'unpreservable-shape'));
    },
  );
});

test('F3: an extra group key skips as unpreservable-shape', () => {
  const settings = {
    hooks: {
      Stop: [
        {
          description: 'nope',
          hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/grph.mjs' }],
        },
      ],
    },
  };
  withHookEnv(['grph.mjs'], settings, (env) => {
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      new Set(),
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'unpreservable-shape'));
  });
});

test('F3: a non-positive-integer timeout skips as unpreservable-shape', () => {
  for (const timeout of [0, -5, 1.5, 'x']) {
    withHookEnv(['toh.mjs'], oneHook('node $HOME/.claude/hooks/toh.mjs', { timeout }), (env) => {
      const { candidates, skipped } = scanHookCandidates(
        env.claudeHome,
        env.settingsPath,
        {},
        new Set(),
      );
      assert.equal(candidates.length, 0, `timeout ${timeout} must not capture`);
      assert.ok(
        skipped.some((s) => s.reason === 'unpreservable-shape'),
        `timeout ${timeout}`,
      );
    });
  }
});

test('F6: a case-folded duplicate basename skips every registration', () => {
  const settings = {
    hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/dup.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/DUP.mjs' }] }],
    },
  };
  withHookEnv(['dup.mjs', 'DUP.mjs'], settings, (env) => {
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      new Set(),
    );
    assert.equal(candidates.length, 0);
    const dups = skipped.filter((s) => s.reason === 'duplicate-registration');
    assert.equal(dups.length, 2, 'both registrations of the case-folded basename are skipped');
  });
});

test('an event outside HOOK_EVENT_ALLOWLIST skips', () => {
  const settings = {
    hooks: {
      NotARealEvent: [
        { hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/evh.mjs' }] },
      ],
    },
  };
  withHookEnv(['evh.mjs'], settings, (env) => {
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      new Set(),
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'event-not-allowlisted'));
  });
});

test('a non-command hook type skips', () => {
  withHookEnv(['ph.mjs'], oneHook('node $HOME/.claude/hooks/ph.mjs', {}), (env) => {
    // Overwrite type to a non-command value.
    const s = JSON.parse(readFileSync(env.settingsPath, 'utf-8'));
    s.hooks.PostToolUse[0].hooks[0].type = 'prompt';
    writeFileSync(env.settingsPath, JSON.stringify(s));
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      new Set(),
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s2) => s2.reason === 'non-command-type'));
  });
});

test('a core hook basename (from hooks.json) is excluded', () => {
  // Use the REAL derived core basenames so this pins the F5 hooks.json reservation.
  const cfg = readCoreHooksConfig(REPO);
  assert.ok(cfg.ok, 'repo hooks.json must load');
  const coreBasenames = deriveCoreHookBasenames(cfg.cfg);
  assert.ok(
    coreBasenames.has('version-check.mjs'),
    'version-check.mjs must be a reserved shared name',
  );
  const settings = oneHook('node $HOME/.claude/hooks/version-check.mjs');
  withHookEnv(['version-check.mjs'], settings, (env) => {
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      coreBasenames,
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'core-hook'));
  });
});

test('an already-owned hook (recorded install-path key) is excluded', () => {
  withHookEnv(['ownedh.mjs'], oneHook('node $HOME/.claude/hooks/ownedh.mjs'), (env) => {
    const recorded = { 'hooks/ownedh.mjs': 'somesha' };
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      recorded,
      new Set(),
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason.startsWith('already-managed')));
  });
});

test('a hypo-* namespaced command is excluded at parse (invalid-stem)', () => {
  withHookEnv([], oneHook('node $HOME/.claude/hooks/hypo-ext-x.mjs'), (env) => {
    const { candidates, skipped } = scanHookCandidates(
      env.claudeHome,
      env.settingsPath,
      {},
      new Set(),
    );
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'invalid-stem'));
  });
});

test('a symlinked source (non-regular) is refused as unresolved-source', () => {
  withTmpDir((dir) => {
    const claudeHome = join(dir, '.claude');
    const hooksDir = join(claudeHome, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const outside = join(dir, 'evil.mjs');
    writeFileSync(outside, '#!/usr/bin/env node\n');
    symlinkSync(outside, join(hooksDir, 'symh.mjs'));
    const settingsPath = join(claudeHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(oneHook('node $HOME/.claude/hooks/symh.mjs')));
    const { candidates, skipped } = scanHookCandidates(claudeHome, settingsPath, {}, new Set());
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'unresolved-source'));
  });
});

// ── reverse hook capture: end-to-end CLI (success criteria a-e + adopt) ────────

// Register one canonical hook (a real .mjs source + the exact settings.json form
// forward-sync emits) so the capture → adopt round-trip can be observed whole.
function seedCanonicalHook(home, { stem, event = 'PostToolUse', matcher, timeout, body }) {
  const hooksDir = join(home, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${stem}.mjs`), body);
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {};
  settings.hooks = settings.hooks || {};
  const hookEntry = { type: 'command', command: `node $HOME/.claude/hooks/${stem}.mjs` };
  if (timeout !== undefined) hookEntry.timeout = timeout;
  const group = { hooks: [hookEntry] };
  if (matcher !== undefined) group.matcher = matcher;
  settings.hooks[event] = (settings.hooks[event] || []).concat([group]);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settingsPath;
}

suite('capture: reverse hook capture end-to-end (T4, success criteria a-e)');

test('captures a canonical hook losslessly and adopts it under the original name', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const body = '#!/usr/bin/env node\nprocess.exit(0)\n';
      const settingsPath = seedCanonicalHook(home, {
        stem: 'myhook',
        matcher: 'Write|Edit',
        timeout: 10000,
        body,
      });

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);

      // (a) wiki .mjs is byte-identical and the manifest carries every field.
      const wikiDir = join(hypoDir, 'extensions', 'hooks');
      assert.equal(readFileSync(join(wikiDir, 'hypo-ext-myhook.mjs'), 'utf-8'), body);
      const manifest = JSON.parse(
        readFileSync(join(wikiDir, 'hypo-ext-myhook.manifest.json'), 'utf-8'),
      );
      assert.deepEqual(manifest, {
        type: 'hook',
        installName: 'myhook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 10000,
      });

      // (d) BOTH SHA keys are owned under the install path; wiki-storage keys are not.
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(pkg.extensions.claude['hooks/myhook.mjs'], 'mjs key owned');
      assert.ok(pkg.extensions.claude['hooks/myhook.manifest.json'], 'sidecar key owned');
      assert.ok(!pkg.extensions.claude['hooks/hypo-ext-myhook.mjs'], 'wiki-name key not recorded');

      // (b)(c)(e) exactly one registration, command char-identical, fields restored,
      // no hypo-ext-* name leaked into settings.
      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const groups = (after.hooks.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('myhook.mjs')),
      );
      assert.equal(groups.length, 1, 'no duplicate registration (e)');
      assert.equal(
        groups[0].hooks[0].command,
        'node $HOME/.claude/hooks/myhook.mjs',
        'command char-identical (b)',
      );
      assert.equal(groups[0].matcher, 'Write|Edit', 'matcher restored (c)');
      assert.equal(groups[0].hooks[0].timeout, 10000, 'timeout restored (c)');
      assert.ok(
        !/hypo-ext-myhook/.test(readFileSync(settingsPath, 'utf-8')),
        'no wiki name in settings',
      );
    });
  });
});

test('omits an empty matcher from the reverse-generated manifest', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      seedCanonicalHook(home, { stem: 'nomatch', matcher: '', body: '#!/usr/bin/env node\n' });
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);
      const manifest = JSON.parse(
        readFileSync(
          join(hypoDir, 'extensions', 'hooks', 'hypo-ext-nomatch.manifest.json'),
          'utf-8',
        ),
      );
      assert.deepEqual(manifest, { type: 'hook', installName: 'nomatch', event: 'PostToolUse' });
    });
  });
});

test('--dry-run writes nothing to the wiki and does not adopt', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      seedCanonicalHook(home, { stem: 'dryh', body: '#!/usr/bin/env node\n' });
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all', '--dry-run'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Would capture/);
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-dryh.mjs')),
        'dry-run must not write the wiki .mjs',
      );
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const owned = existsSync(pkgPath)
        ? (JSON.parse(readFileSync(pkgPath, 'utf-8')).extensions?.claude ?? {})
        : {};
      assert.ok(!owned['hooks/dryh.mjs'], 'dry-run must not adopt');
    });
  });
});

test('a lossy hook writes nothing to the wiki and surfaces a skip reason', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      // Absolute-path registration is legal but non-canonical → visible skip.
      const hooksDir = join(home, '.claude', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'abs.mjs'), '#!/usr/bin/env node\n');
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: `node ${home}/.claude/hooks/abs.mjs` }] }],
          },
        }),
      );
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.match(r.stdout, /path-not-under-home-hooks/, 'absolute path is a visible skip');
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-abs.mjs')),
        'nothing written to the wiki for a lossy hook',
      );
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-abs.manifest.json')),
        'no manifest written for a lossy hook',
      );
    });
  });
});

test('--type=hooks captures only hooks; --all and [names] select as expected', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      // One command extension + two hooks.
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'mycmd.md'), '# cmd\n');
      seedCanonicalHook(home, { stem: 'hookone', body: '#!/usr/bin/env node\n// one\n' });
      seedCanonicalHook(home, {
        stem: 'hooktwo',
        event: 'Stop',
        body: '#!/usr/bin/env node\n// two\n',
      });

      // --type=hooks: only the hooks are captured, not the command.
      const rt = runWithHome(
        'capture.mjs',
        [`--hypo-dir=${hypoDir}`, '--type=hooks', '--all'],
        home,
      );
      assert.equal(rt.status, 0, rt.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-hookone.mjs')));
      assert.ok(existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-hooktwo.mjs')));
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mycmd.md')),
        '--type=hooks must not capture the command',
      );
    });
  });
});

test('[names] captures only the named hook stem', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      seedCanonicalHook(home, { stem: 'keepme', body: '#!/usr/bin/env node\n// keep\n' });
      seedCanonicalHook(home, {
        stem: 'skipme',
        event: 'Stop',
        body: '#!/usr/bin/env node\n// skip\n',
      });
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'keepme'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-keepme.mjs')));
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-skipme.mjs')),
        'only the named stem is captured',
      );
    });
  });
});

test('--all also includes hooks alongside commands', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'bothcmd.md'), '# cmd\n');
      seedCanonicalHook(home, { stem: 'bothhook', body: '#!/usr/bin/env node\n' });
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-bothcmd.md')));
      assert.ok(existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-bothhook.mjs')));
    });
  });
});

test('adopt failure rolls back the wiki hook writes (sidecar install path blocked)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      seedCanonicalHook(home, { stem: 'failh', body: '#!/usr/bin/env node\n' });
      // Plant a symlink at the sidecar install path so forward-sync cannot own the
      // manifest: the `.mjs` key is owned but the sidecar key is not, so the dual-key
      // adopt verification fails and rollbackRec must undo the wiki writes.
      const outside = join(dir, 'not-a-manifest');
      writeFileSync(outside, 'x');
      symlinkSync(outside, join(home, '.claude', 'hooks', 'failh.manifest.json'));
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 1, 'a failed adopt exits non-zero');
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-failh.mjs')),
        'wiki .mjs rolled back',
      );
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-failh.manifest.json')),
        'wiki manifest rolled back',
      );
    });
  });
});

// ── directory skills: reverse capture (skills-capture design) ────────────────
//
// A skill is a DIRECTORY, and capture must put into the wiki exactly what the far
// machine will install back. These drive the real CLI end to end.

const { ownedSkillDirs, planSkillCapture, scanSkillCandidates } = await import(
  `${SCRIPTS}/capture.mjs`
);

suite('capture: directory skills (scan + plan)');

test('ownedSkillDirs trusts only validly recorded skill keys', () => {
  const owned = ownedSkillDirs({
    'skills/good': { 'SKILL.md': 'a'.repeat(64) },
    'skills/corrupt': 'not-a-nested-map', // shape mismatch → not ownership
    'skills/empty': {}, // owns nothing → not ownership
    'skills/../escape': { 'SKILL.md': 'b'.repeat(64) }, // unparseable key
    'commands/x.md': 'c'.repeat(64), // flat key, not a skill
  });
  assert.deepEqual([...owned], ['good']);
});

// A corrupt pkg-json must not lock a skill out of capture forever by reading as
// "already managed" (codex design review W2-6).
test('a corrupt skills/<name> record does not mark the skill as already-managed', () => {
  withTmpHome((home) => {
    const skill = join(home, '.claude', 'skills', 'mine');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# mine\n');
    const owned = ownedSkillDirs({ 'skills/mine': 'not-a-nested-map' });
    const { candidates } = scanSkillCandidates(join(home, '.claude'), owned);
    assert.deepEqual(
      candidates.map((c) => c.file),
      ['mine'],
    );
  });
});

test('planSkillCapture: ready only when the wiki directory is wholly absent', () => {
  const wantManifest = { type: 'skill', installName: 'mine' };
  const srcShas = { 'SKILL.md': 'a'.repeat(64) };
  assert.equal(
    planSkillCapture({ wantManifest, srcShas, wikiPresent: false, wikiShas: null }).status,
    'ready',
  );
  // Present + identical + matching manifest → already (no-op).
  assert.equal(
    planSkillCapture({
      wantManifest,
      srcShas,
      wikiPresent: true,
      wikiShas: { 'SKILL.md': 'a'.repeat(64) },
      existingManifestRaw: JSON.stringify(wantManifest),
    }).status,
    'already',
  );
  // Present + different content → conflict, never a silent overwrite.
  assert.equal(
    planSkillCapture({
      wantManifest,
      srcShas,
      wikiPresent: true,
      wikiShas: { 'SKILL.md': 'b'.repeat(64) },
      existingManifestRaw: JSON.stringify(wantManifest),
    }).status,
    'conflict',
  );
  // Present but unreadable as a skill (crash-truncated, symlinked, a plain file):
  // conflict, so the rollback is never handed a directory it did not create.
  assert.equal(
    planSkillCapture({ wantManifest, srcShas, wikiPresent: true, wikiShas: null }).status,
    'conflict',
  );
  // Identical content but no sidecar → conflict: install semantics would differ.
  assert.equal(
    planSkillCapture({
      wantManifest,
      srcShas,
      wikiPresent: true,
      wikiShas: { 'SKILL.md': 'a'.repeat(64) },
      existingManifestRaw: null,
    }).status,
    'conflict',
  );
});

// Everything that cannot round-trip through the wiki refuses the WHOLE skill: a
// lossy wiki copy is what the far machine would install (design §2).
test('a subtree that cannot round-trip refuses the whole skill, with a reason', () => {
  withTmpHome((home) => {
    const skills = join(home, '.claude', 'skills');
    const mk = (name) => {
      const d = join(skills, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `# ${name}\n`);
      return d;
    };
    const link = mk('haslink');
    symlinkSync('/etc/hosts', join(link, 'evil.md'));
    const empty = mk('hasempty');
    mkdirSync(join(empty, 'templates'));
    const vcs = mk('hasvcs');
    mkdirSync(join(vcs, '.git'));
    writeFileSync(join(vcs, '.git', 'config'), '[core]\n');
    const nosk = join(skills, 'noskill');
    mkdirSync(nosk, { recursive: true });
    writeFileSync(join(nosk, 'README.md'), '# not a skill\n');
    mk('clean');

    const { candidates, skipped } = scanSkillCandidates(join(home, '.claude'), new Set());
    assert.deepEqual(
      candidates.map((c) => c.file),
      ['clean'],
      'only the clean skill is capturable',
    );
    const reasons = Object.fromEntries(skipped.map((s) => [s.file, s.reason]));
    assert.match(reasons.haslink, /not a regular file/);
    assert.match(reasons.hasempty, /empty directory/);
    assert.match(reasons.hasvcs, /VCS control directory/);
    assert.match(reasons.noskill, /SKILL\.md/);
  });
});

// The ceiling is what stops a vendored skill (gstack: 14k files / 1.1GB) from being
// copied into a git vault. It must land BEFORE any file is read.
test('a skill over the file ceiling is refused with the measured count', () => {
  withTmpHome((home) => {
    const d = join(home, '.claude', 'skills', 'huge');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '# huge\n');
    for (let i = 0; i < 520; i++) writeFileSync(join(d, `f${i}.md`), 'x\n');
    const { candidates, skipped } = scanSkillCandidates(join(home, '.claude'), new Set());
    assert.equal(candidates.length, 0, 'an oversized skill is not a candidate');
    assert.match(skipped[0].reason, /over 500 files/);
  });
});

suite('capture: directory skills end-to-end (adopt + round-trip)');

// Success criterion 1 + 2. The round-trip check MUST use a SECOND home: for skills the
// capture source and the install target are the SAME directory, so re-syncing onto the
// source only proves adopt is a no-op and would hide a broken far machine.
test('captures a directory skill, adopts it, and reinstalls it on a second machine', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(join(src, 'references'), { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      writeFileSync(join(src, 'references', 'a.md'), 'ref a\n');

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);

      const wikiSkill = join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine');
      assert.ok(existsSync(join(wikiSkill, 'SKILL.md')), 'SKILL.md stored in the wiki');
      assert.ok(existsSync(join(wikiSkill, 'references', 'a.md')), 'subtree stored in the wiki');
      const manifest = JSON.parse(
        readFileSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine.manifest.json'), 'utf-8'),
      );
      assert.deepEqual(manifest, { type: 'skill', installName: 'mine' });

      const owned = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'))
        .extensions.claude['skills/mine'];
      assert.equal(typeof owned, 'object', 'ownership is a nested per-relpath map');
      assert.deepEqual(Object.keys(owned).sort(), ['SKILL.md', 'references/a.md']);

      // Second machine: a fresh HOME pointed at the same wiki must reproduce the skill.
      withTmpHome((home2) => {
        const up = runWithHome('upgrade.mjs', ['--apply', `--hypo-dir=${hypoDir}`], home2);
        assert.equal(up.status, 0, up.stderr);
        const far = join(home2, '.claude', 'skills', 'mine');
        assert.equal(readFileSync(join(far, 'SKILL.md'), 'utf-8'), '# mine\n');
        assert.equal(readFileSync(join(far, 'references', 'a.md'), 'utf-8'), 'ref a\n');
        assert.ok(
          !existsSync(join(home2, '.claude', 'skills', 'hypo-ext-mine')),
          'installs under the original name, not the wiki storage name',
        );
      });
    });
  });
});

test('--dry-run writes nothing to the wiki and does not adopt a skill', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all', '--dry-run'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine')));
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(!pkg.extensions.claude['skills/mine'], 'dry-run records no ownership');
    });
  });
});

// A second capture of the same skill is a no-op, not a conflict and not a rewrite.
test('re-capturing an unchanged skill reports already, and a changed wiki copy refuses', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      assert.equal(runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home).status, 0);

      // Now owned: the skill is no longer even a candidate.
      const again = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'mine'], home);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /no capturable candidate/);

      // Drop the ownership record but leave a DIFFERENT wiki copy: capture must refuse
      // rather than silently overwrite what the wiki already carries.
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      delete pkg.extensions.claude['skills/mine'];
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      writeFileSync(
        join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine', 'SKILL.md'),
        '# edited in the wiki\n',
      );
      const conflict = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'mine'], home);
      assert.match(conflict.stdout, /different content/);
      assert.equal(
        readFileSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine', 'SKILL.md'), 'utf-8'),
        '# edited in the wiki\n',
        'the wiki copy is left alone',
      );
    });
  });
});

// A bare name that matches both a command and a skill must not silently pick one
// (codex design review W2-7).
test('an ambiguous bare name is refused and nothing is captured', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(home, '.claude', 'commands', 'mine.md'), '# cmd\n');
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# skill\n');

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'mine'], home);
      assert.match(r.stdout, /ambiguous/);
      assert.ok(!existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine')));
      assert.ok(!existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mine.md')));

      // Qualifying by type resolves it.
      const q = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'skills/mine'], home);
      assert.equal(q.status, 0, q.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine', 'SKILL.md')));
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mine.md')),
        'the command was not captured',
      );
    });
  });
});

// The rollback ledger is authoritative. A refused write must not delete a wiki path the
// run never touched: a DANGLING sidecar symlink is invisible to existsSync, the boundary
// guard refuses the write, and the old rollback then unlinked the symlink anyway (codex
// pre-commit BLOCKER, reproduced).
test('a refused skill write never deletes a wiki path the run did not create', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      const sidecar = join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine.manifest.json');
      symlinkSync(join(dir, 'no-such-target'), sidecar);

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, 'skills/mine'], home);
      assert.match(r.stdout, /symlinked directory/);
      assert.ok(lstatSync(sidecar).isSymbolicLink(), 'the pre-existing symlink is left alone');
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine')),
        'nothing was written',
      );
    });
  });
});

// A file legitimately named `__proto__` must be tracked as an own key, not assigned
// through the prototype setter (codex pre-commit CONCERN; forward-sync already guards
// this, so capture must too or the two disagree about what was captured).
test('a skill file named __proto__ is captured and owned like any other', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      writeFileSync(join(src, '__proto__'), 'polluted?\n');

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine', '__proto__')));
      const owned = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'))
        .extensions.claude['skills/mine'];
      assert.deepEqual(Object.keys(owned).sort(), ['SKILL.md', '__proto__']);
    });
  });
});

// Capture must judge a source file by the rule that will apply AFTER it lands in the
// wiki. forward-sync discovers the wiki subtree through the vault's .hypoignore, so a
// file the vault ignores would be written, then dropped from discovery, and the adopt
// check would fail with nothing a user could act on. Refuse it up front, naming the file.
test('a skill holding a file the vault ignores is refused up front, not at adopt time', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      writeFileSync(join(hypoDir, '.hypoignore'), '*.pdf\n');
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(join(src, 'references'), { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      writeFileSync(join(src, 'references', 'spec.pdf'), '%PDF-1.4\n');

      const r = runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home);
      assert.match(r.stdout, /references\/spec\.pdf matches the vault \.hypoignore/);
      assert.ok(
        !existsSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-mine')),
        'nothing is written to the wiki',
      );
      assert.doesNotMatch(r.stdout, /Failed to adopt/, 'refused at scan time, not at adopt');
    });
  });
});

// Success criterion 10: uninstall reaches a captured skill through its SHA-map key.
test('uninstall removes a captured skill and preserves an unowned file inside it', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      assert.equal(
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home).status,
        0,
      );
      const src = join(home, '.claude', 'skills', 'mine');
      mkdirSync(join(src, 'references'), { recursive: true });
      writeFileSync(join(src, 'SKILL.md'), '# mine\n');
      writeFileSync(join(src, 'references', 'a.md'), 'ref a\n');
      assert.equal(runWithHome('capture.mjs', [`--hypo-dir=${hypoDir}`, '--all'], home).status, 0);

      writeFileSync(join(src, 'notes.md'), 'my own notes\n'); // unowned
      const r = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(src, 'SKILL.md')), 'owned SKILL.md removed');
      assert.ok(!existsSync(join(src, 'references', 'a.md')), 'owned subtree file removed');
      assert.equal(readFileSync(join(src, 'notes.md'), 'utf-8'), 'my own notes\n', 'unowned kept');
    });
  });
});
