// tests/extensions.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { test, suite } from './harness.mjs';
import { runWithHome, withTmpDir, withTmpHome, writeExt } from './helpers.mjs';

// ── extensions companion sync (ADR 0024) ──────────────────────

suite('extensions companion sync (upgrade.mjs, ADR 0024)');

// §8.12 (a) new extension → hard copy + manifest parse + settings.json entry +
// 3-way SHA record; §8.12 (b) re-run is idempotent (no diff, settings stable).
test('upgrade-extensions-hard-copy-and-manifest-register', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-mywatcher.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 10000,
      });

      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);

      // (a-1) hard copy of the hook AND its manifest into ~/.claude/hooks/
      const copyDir = join(home, '.claude', 'hooks');
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-mywatcher.mjs')),
        'extension hook not hard-copied to ~/.claude/hooks/',
      );
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-mywatcher.manifest.json')),
        'extension manifest not hard-copied alongside the hook',
      );

      // (a-2) settings.json registered the hook with a command WE constructed
      // (never sourced from the manifest), plus matcher + timeout from manifest.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const groups = (settings.hooks?.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-mywatcher.mjs')),
      );
      assert.equal(groups.length, 1, 'exactly one PostToolUse entry expected for the extension');
      assert.equal(groups[0].matcher, 'Write|Edit', 'matcher from manifest not applied');
      assert.equal(
        groups[0].hooks[0].command,
        'node $HOME/.claude/hooks/hypo-ext-mywatcher.mjs',
        'command must be constructed by us, not sourced from manifest',
      );
      assert.equal(groups[0].hooks[0].timeout, 10000, 'timeout from manifest not applied');

      // (a-3) per-target SHA recorded WITHOUT clobbering the commands map.
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(pkg.commands && Object.keys(pkg.commands).length > 0, 'commands map was dropped');
      assert.ok(pkg.extensions?.claude, 'extensions.claude per-target map missing');
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-mywatcher.mjs'],
        'hook SHA not recorded under extensions.claude',
      );
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-mywatcher.manifest.json'],
        'manifest SHA not recorded under extensions.claude',
      );

      // (b) idempotency — second --apply syncs nothing and leaves settings stable.
      const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const out2 = JSON.parse(r2.stdout);
      const synced2 = out2.applied.extensions.actions.filter((a) =>
        ['create', 'update', 'force-update'].includes(a.action),
      );
      assert.equal(synced2.length, 0, 'second --apply should sync nothing (idempotent)');
      assert.equal(
        out2.applied.extensions.settingsChanged,
        false,
        'second --apply must not rewrite settings.json',
      );
      assert.equal(out2.extensions.needsWork, false, 'no drift expected on second check');
      const settingsAfter = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');
      assert.equal(
        settingsAfter,
        settingsBefore,
        'settings.json drifted across idempotent --apply',
      );
    });
  });
});

// §8.12 (6) .hypoignore-matched files are excluded from discovery/sync.
test('extensions-respects-hypoignore', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // One synced extension and one that .hypoignore must exclude.
      writeExt(hypoDir, 'hooks', 'hypo-ext-keep.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      writeExt(hypoDir, 'hooks', 'hypo-ext-skipme.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      const hypoignorePath = join(hypoDir, '.hypoignore');
      writeFileSync(
        hypoignorePath,
        readFileSync(hypoignorePath, 'utf-8') + '\n# test exclusion\n*skipme*\n',
      );

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);

      const copyDir = join(home, '.claude', 'hooks');
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-keep.mjs')),
        'non-ignored extension should be synced',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-skipme.mjs')),
        '.hypoignore-matched extension must NOT be synced',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-skipme.manifest.json')),
        '.hypoignore-matched extension manifest must NOT be synced',
      );

      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-keep.mjs'],
        'kept extension SHA should be recorded',
      );
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-skipme.mjs'],
        'ignored extension SHA must not be recorded',
      );
    });
  });
});

// D2 ordering: a malformed manifest (unknown event) must skip the extension
// entirely — no orphaned, unregistered hook copy left behind.
test('extensions: malformed manifest leaves no orphan hard-copy', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-bad.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'BogusEvent',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      assert.ok(
        !existsSync(join(home, '.claude', 'hooks', 'hypo-ext-bad.mjs')),
        'malformed-manifest extension must NOT be hard-copied (D2: validate before copy)',
      );
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const registered = JSON.stringify(settings.hooks || {}).includes('hypo-ext-bad');
      assert.ok(!registered, 'malformed-manifest extension must NOT be registered');
    });
  });
});

// Security #9: a hostile `command` field in the manifest must be ignored — the
// settings entry command is always constructed locally.
test('extensions: manifest command field cannot inject a command path', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-evil.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
        command: 'rm -rf /',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const group = (settings.hooks?.Stop || []).find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-evil.mjs')),
      );
      assert.ok(group, 'extension should still be registered');
      assert.equal(
        group.hooks[0].command,
        'node $HOME/.claude/hooks/hypo-ext-evil.mjs',
        'command must be constructed locally, never sourced from the manifest',
      );
      assert.ok(
        !JSON.stringify(settings).includes('rm -rf'),
        'manifest command field must never reach settings.json',
      );
    });
  });
});

// HIGH (codex E2 review): a pre-existing unowned hook copy must NOT be wired up.
// We refuse to overwrite it, so we must also refuse to copy its manifest or
// register a settings entry that would activate a file we don't own.
test('extensions: conflict on main file blocks manifest copy + registration', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // A foreign, unowned file already sits where our extension would land.
      const claudeHooks = join(home, '.claude', 'hooks');
      mkdirSync(claudeHooks, { recursive: true });
      writeFileSync(join(claudeHooks, 'hypo-ext-conflict.mjs'), '// not ours\n');

      writeExt(hypoDir, 'hooks', 'hypo-ext-conflict.mjs', '#!/usr/bin/env node\n// ours\n', {
        type: 'hook',
        event: 'PostToolUse',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      // E3 (fix #31): a hard conflict blocks install with exit 1 even under --apply.
      assert.equal(r.status, 1, `conflict must block with exit 1: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.extensions.conflicts.some((c) => c.file === 'hooks/hypo-ext-conflict.mjs'),
        'conflict must be reported in extensions.conflicts',
      );

      // Foreign file left untouched.
      assert.equal(
        readFileSync(join(claudeHooks, 'hypo-ext-conflict.mjs'), 'utf-8'),
        '// not ours\n',
        'foreign file must not be overwritten',
      );
      // Manifest NOT copied (we do not own the main file).
      assert.ok(
        !existsSync(join(claudeHooks, 'hypo-ext-conflict.manifest.json')),
        'manifest must not be copied for an unowned/conflicted main file',
      );
      // NOT registered in settings.json.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      assert.ok(
        !JSON.stringify(settings.hooks || {}).includes('hypo-ext-conflict.mjs'),
        'conflicted extension must NOT be registered in settings.json',
      );
    });
  });
});

// fix #31: the init.mjs conflict path must also block (exit 1) and report the
// recovery — not throw. (Guards against the errors-bucket name typo.)
test('extensions: init blocks on a hard conflict (exit 1, no throw)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `first init failed: ${initR.stderr}`);

      // A foreign, unowned file occupies the target; author the extension.
      const claudeHooks = join(home, '.claude', 'hooks');
      writeFileSync(join(claudeHooks, 'hypo-ext-foreign.mjs'), '// not ours\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-foreign.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
      });

      const r = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 1, 'init must exit 1 on a hard extension conflict');
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.ok(
        combined.includes('existing file conflicts'),
        'init must surface the conflict recovery message',
      );
      assert.equal(
        readFileSync(join(claudeHooks, 'hypo-ext-foreign.mjs'), 'utf-8'),
        '// not ours\n',
        'foreign file must remain untouched',
      );
    });
  });
});

// §8.12 (c) — fix #31: a user-edited owned copy is DRIFT (warn + check-mode exit 1,
// not a hard --apply block); --force-extensions backs it up (.bak) and overwrites.
// A foreign symlink at the target is a conflict that --force-extensions never
// follows (it stays exit 1).
test('extensions-conflict-detected-blocks-without-force', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const claudeHooks = join(home, '.claude', 'hooks');
      const installed = join(claudeHooks, 'hypo-ext-drift.mjs');

      // Author + install an extension we own.
      writeExt(hypoDir, 'hooks', 'hypo-ext-drift.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(r1.status, 0, `initial sync failed: ${r1.stderr}`);
      assert.ok(existsSync(installed), 'extension should be installed');

      // The user edits the installed copy → drift (we own it, recorded SHA ≠ disk).
      writeFileSync(installed, '#!/usr/bin/env node\n// hand-edited\n');

      // (a) --check (no apply) → exit 1, reported as drift, file untouched.
      const rc = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      assert.equal(rc.status, 1, 'drift must fail check mode (exit 1)');
      const checkOut = JSON.parse(rc.stdout);
      assert.ok(
        checkOut.extensions.drifts.some((d) => d.file === 'hooks/hypo-ext-drift.mjs'),
        'drift must be reported in extensions.drifts',
      );
      assert.equal(checkOut.extensions.conflicts.length, 0, 'drift is not a hard conflict');
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'check mode must not overwrite a drifted file',
      );

      // Non-JSON summary must stay consistent with the exit code: drift is pending
      // work, so the summary must NOT claim "up to date" while exiting 1.
      const rcText = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.equal(rcText.status, 1, 'drift must fail check mode (non-JSON)');
      assert.ok(
        !rcText.stdout.includes('Hypomnema is up to date'),
        'summary must not say "up to date" when drift is pending',
      );
      assert.ok(
        rcText.stdout.includes('drift detected'),
        'summary must surface the drift recovery message',
      );

      // (b) --apply WITHOUT force → drift is advisory, NOT a hard block (exit 0),
      // and the user's edit is preserved (mirrors slash-command drift semantics).
      const ra = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(ra.status, 0, `drift must not hard-block --apply: ${ra.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'apply without --force-extensions must not overwrite a drifted file',
      );

      // (c) --apply --force-extensions → backup (.bak) + overwrite from source.
      const rf = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--force-extensions'],
        home,
      );
      assert.equal(rf.status, 0, `force apply failed: ${rf.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// v1\n',
        '--force-extensions must overwrite with the source content',
      );
      assert.ok(existsSync(`${installed}.bak`), '--force-extensions must back up the prior file');
      assert.equal(
        readFileSync(`${installed}.bak`, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'backup must hold the user-edited content',
      );

      // (d) a symlink at the target is a conflict --force-extensions never follows.
      const decoy = join(dir, 'decoy.mjs');
      writeFileSync(decoy, '// decoy\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-link.mjs', '#!/usr/bin/env node\n// linked\n', {
        type: 'hook',
        event: 'Stop',
      });
      symlinkSync(decoy, join(claudeHooks, 'hypo-ext-link.mjs'));
      const rl = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--force-extensions'],
        home,
      );
      assert.equal(rl.status, 1, 'a symlink target must stay a conflict even under --force');
      const linkOut = JSON.parse(rl.stdout);
      assert.ok(
        linkOut.extensions.conflicts.some(
          (c) => c.file === 'hooks/hypo-ext-link.mjs' && c.action === 'skip-non-regular',
        ),
        'symlink must be reported as a non-regular conflict',
      );
      assert.equal(readFileSync(decoy, 'utf-8'), '// decoy\n', 'symlink target must be untouched');
    });
  });
});

// MEDIUM (codex E2 review, §8.12 b): a manifest matcher/timeout change must be
// reflected in the existing settings entry; an event change must migrate it
// (no orphaned entry left in the old event).
test('extensions: manifest change re-registers settings entry', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const manifestPath = join(hypoDir, 'extensions', 'hooks', 'hypo-ext-edit.manifest.json');
      writeExt(hypoDir, 'hooks', 'hypo-ext-edit.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 5000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);

      // Change matcher + timeout → expect the existing entry updated in place.
      writeFileSync(
        manifestPath,
        JSON.stringify({ type: 'hook', event: 'PostToolUse', matcher: 'Edit', timeout: 9000 }),
      );
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const s2 = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const post = (s2.hooks.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      assert.equal(post.length, 1, 'exactly one entry expected after matcher change');
      assert.equal(post[0].matcher, 'Edit', 'matcher should be updated');
      assert.equal(post[0].hooks[0].timeout, 9000, 'timeout should be updated');

      // Change event → migrate (old event entry removed, new event entry added).
      writeFileSync(manifestPath, JSON.stringify({ type: 'hook', event: 'Stop' }));
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      const s3 = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const stillPost = (s3.hooks.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      const nowStop = (s3.hooks.Stop || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      assert.equal(stillPost.length, 0, 'old-event entry must be removed on event migration');
      assert.equal(nowStop.length, 1, 'entry must move to the new event');
    });
  });
});

// MEDIUM (codex E2 review): a .hypoignore-matched manifest must be excluded too
// — the hook then has no manifest (warns, hard-copy proceeds, not registered).
test('extensions: .hypoignore-matched manifest is not copied or recorded', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-partial.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      const hypoignorePath = join(hypoDir, '.hypoignore');
      writeFileSync(hypoignorePath, readFileSync(hypoignorePath, 'utf-8') + '\n*.manifest.json\n');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const claudeHooks = join(home, '.claude', 'hooks');
      assert.ok(existsSync(join(claudeHooks, 'hypo-ext-partial.mjs')), 'hook should still copy');
      assert.ok(
        !existsSync(join(claudeHooks, 'hypo-ext-partial.manifest.json')),
        'ignored manifest must not be copied',
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-partial.manifest.json'],
        'ignored manifest SHA must not be recorded',
      );
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      assert.ok(
        !JSON.stringify(settings.hooks || {}).includes('hypo-ext-partial.mjs'),
        'without a manifest the hook must not auto-register',
      );
    });
  });
});

// §8.12 (5) --codex mirrors the extensions sync into ~/.codex (hooks + commands
// only; skills/agents skipped with a notice). Covers BOTH entry points (upgrade
// here, init below) — the E3 review showed a shared sync fn can still leak
// per-entry-point wiring bugs.
test('extensions-codex-sync', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // A hook (registrable), a command, and a skill (Codex-unsupported → skip).
      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxwatch.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 8000,
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-cdxcmd.md', '# codex command\n');
      writeExt(hypoDir, 'skills', 'hypo-ext-cdxskill.md', '# claude-only skill\n');

      // (sanity) a plain --apply must NEVER touch ~/.codex.
      const rNoCdx = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(rNoCdx.status, 0, `claude-only apply failed: ${rNoCdx.stderr}`);
      assert.ok(
        !existsSync(join(home, '.codex', 'hooks', 'hypo-ext-cdxwatch.mjs')),
        'without --codex nothing must be written into ~/.codex',
      );

      // ── entry point 1: upgrade --codex --apply ──
      const rUp = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(rUp.status, 0, `upgrade --codex failed: ${rUp.stderr}`);
      const up = JSON.parse(rUp.stdout);

      const cdxHooks = join(home, '.codex', 'hooks');
      const cdxCmds = join(home, '.codex', 'commands');
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-ext-cdxwatch.mjs')),
        'hook not hard-copied to ~/.codex/hooks',
      );
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-ext-cdxwatch.manifest.json')),
        'manifest not hard-copied to ~/.codex/hooks',
      );
      assert.ok(
        existsSync(join(cdxCmds, 'hypo-ext-cdxcmd.md')),
        'command not hard-copied to ~/.codex/commands',
      );
      assert.ok(
        !existsSync(join(home, '.codex', 'skills', 'hypo-ext-cdxskill.md')),
        'skill extension must be skipped for the codex target',
      );

      // ~/.codex/settings.json entry uses a command WE constructed, pointing at ~/.codex.
      const cdxSettings = JSON.parse(readFileSync(join(home, '.codex', 'settings.json'), 'utf-8'));
      const grp = (cdxSettings.hooks?.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-cdxwatch.mjs')),
      );
      assert.equal(grp.length, 1, 'exactly one codex PostToolUse entry expected');
      assert.equal(
        grp[0].hooks[0].command,
        'node $HOME/.codex/hooks/hypo-ext-cdxwatch.mjs',
        'codex command must point at ~/.codex and be constructed by us',
      );
      assert.equal(grp[0].matcher, 'Write', 'codex matcher from manifest not applied');

      // per-target SHA: BOTH claude and codex maps must survive (regression guard).
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions?.claude?.['hooks/hypo-ext-cdxwatch.mjs'],
        'claude per-target SHA was dropped by the codex sync',
      );
      assert.ok(
        pkg.extensions?.codex?.['hooks/hypo-ext-cdxwatch.mjs'],
        'codex hook SHA not recorded',
      );
      assert.ok(
        pkg.extensions.codex['commands/hypo-ext-cdxcmd.md'],
        'codex command SHA not recorded',
      );
      assert.ok(
        !pkg.extensions.codex['skills/hypo-ext-cdxskill.md'],
        'skipped skill must not be recorded under codex',
      );

      // skip notice surfaced on the codex result — and NOT on the claude result.
      assert.ok(
        up.extensionsCodex.warnings.some((w) => /skipped for Codex/i.test(w)),
        'a skill/agent skip notice was expected for the codex target',
      );
      assert.ok(
        !up.extensions.warnings.some((w) => /skipped for Codex/i.test(w)),
        'the claude target must not emit a codex skip notice',
      );

      // idempotency: a second --codex --apply syncs nothing new.
      const rUp2 = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(rUp2.status, 0, `second --codex apply failed: ${rUp2.stderr}`);
      const up2 = JSON.parse(rUp2.stdout);
      const synced2 = up2.applied.extensionsCodex.actions.filter((a) =>
        ['create', 'update', 'force-update'].includes(a.action),
      );
      assert.equal(synced2.length, 0, 'second --codex apply should sync nothing (idempotent)');
    });
  });
});

// §8.12 (5) the OTHER entry point: init --codex must run the same codex sync
// (E3 lesson — wiring bugs surface per entry point even with a shared fn).
test('extensions-codex-sync: init --codex entry point', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-icdx.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });

      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-git-init', '--codex'],
        home,
      );
      assert.equal(r.status, 0, `init --codex failed: ${r.stderr}`);
      assert.ok(
        existsSync(join(home, '.codex', 'hooks', 'hypo-ext-icdx.mjs')),
        'init --codex must hard-copy the extension into ~/.codex/hooks',
      );
      const cdxSettings = JSON.parse(readFileSync(join(home, '.codex', 'settings.json'), 'utf-8'));
      assert.ok(
        JSON.stringify(cdxSettings.hooks || {}).includes('hypo-ext-icdx.mjs'),
        'init --codex must register the extension in ~/.codex/settings.json',
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions?.codex?.['hooks/hypo-ext-icdx.mjs'],
        'init --codex must record the codex per-target SHA',
      );
      // init writes the claude target (step 4b) before the codex target (6b) — the
      // codex write must not clobber the claude per-target SHA map.
      assert.ok(
        pkg.extensions?.claude?.['hooks/hypo-ext-icdx.mjs'],
        'init --codex must preserve the claude per-target SHA',
      );
    });
  });
});

// §8.12 (5) + (c): a codex hard conflict (foreign file at the ~/.codex target)
// must block even under --apply (exit 1), leave the file untouched, and never
// report "up to date" — the message/exit consistency the E3 review enforced.
test('extensions-codex-sync: hard conflict blocks even under --apply', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxconf.mjs', '#!/usr/bin/env node\n// source\n', {
        type: 'hook',
        event: 'Stop',
      });
      // Pre-existing UNOWNED file occupying the codex target → hard conflict.
      const cdxHooks = join(home, '.codex', 'hooks');
      mkdirSync(cdxHooks, { recursive: true });
      const target = join(cdxHooks, 'hypo-ext-cdxconf.mjs');
      writeFileSync(target, '// foreign — not ours\n');

      const r = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(r.status, 1, 'a codex hard conflict must exit 1 even under --apply');
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.extensionsCodex.conflicts.some((c) => c.file === 'hooks/hypo-ext-cdxconf.mjs'),
        'codex conflict must be reported in extensionsCodex.conflicts',
      );
      assert.equal(
        readFileSync(target, 'utf-8'),
        '// foreign — not ours\n',
        'a conflicting codex file must be left untouched',
      );

      // The human-readable summary must not contradict the exit code (E3 review).
      const rh = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(rh.status, 1, 'non-JSON codex conflict must also exit 1');
      // The verdict line must not claim everything is settled (E3 message/exit
      // consistency) — per-check "up to date" lines are fine, only the Result is.
      assert.ok(
        !/Result: Hypomnema is up to date/.test(rh.stdout),
        'the summary verdict must not read "up to date" while a codex conflict exists',
      );
    });
  });
});

// §8.12 (5) + 검증 4: --force-extensions resolves a drifted codex copy (backup +
// overwrite). Both entry points forward the flag; this guards the codex wiring.
test('extensions-codex-sync: --force-extensions overwrites a drifted codex copy', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxforce.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'Stop',
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(r1.status, 0, `initial codex sync failed: ${r1.stderr}`);
      const installed = join(home, '.codex', 'hooks', 'hypo-ext-cdxforce.mjs');

      // User edits the installed codex copy (drift) and the source advances to v2.
      writeFileSync(installed, '#!/usr/bin/env node\n// user edit\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxforce.mjs', '#!/usr/bin/env node\n// v2\n', {
        type: 'hook',
        event: 'Stop',
      });

      // Plain --apply must NOT overwrite a drifted (owned-but-edited) codex copy.
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// user edit\n',
        'apply without --force must not overwrite a drifted codex file',
      );

      // --force-extensions backs up (.bak) and overwrites from source.
      const r3 = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--force-extensions'],
        home,
      );
      assert.equal(r3.status, 0, `--force-extensions codex apply failed: ${r3.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// v2\n',
        '--force-extensions must overwrite the codex copy with the source',
      );
      assert.ok(
        existsSync(`${installed}.bak`),
        '--force-extensions must back up the prior codex copy',
      );
    });
  });
});

// §5.1.2 fix #48 — `hypomnema upgrade --codex` must mirror the same core-hook
// drift detection and apply that the claude side already does (init --codex
// installs core hooks into ~/.codex/hooks + registers them in ~/.codex/settings.json
// — upgrade had to catch up). Two cases:
//   (a) init --codex then a stale codex hook → upgrade --apply --codex restores
//   (b) init (no --codex) then upgrade --apply --codex installs codex from scratch
// Both also assert that plain --apply (no --codex) never touches ~/.codex.
test('upgrade-codex-core-hooks-mirror', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      // init --codex so ~/.codex/{hooks,settings.json} already exist.
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-git-init', '--codex'],
        home,
      );
      assert.equal(initR.status, 0, `init --codex failed: ${initR.stderr}`);

      const cdxHooks = join(home, '.codex', 'hooks');
      const cdxSettings = join(home, '.codex', 'settings.json');
      const claudeHooks = join(home, '.claude', 'hooks');
      const cdxHookFile = join(cdxHooks, 'hypo-shared.mjs');
      const claudeHookFile = join(claudeHooks, 'hypo-shared.mjs');

      // Both targets must have the hook installed by init.
      assert.ok(existsSync(cdxHookFile), 'init --codex must install core hooks to ~/.codex/hooks');
      assert.ok(existsSync(claudeHookFile), 'init must install core hooks to ~/.claude/hooks');

      // Mutate the codex copy → introduce stale drift. Same byte change in claude
      // would be detected too (regression for both sides).
      writeFileSync(cdxHookFile, '// drifted codex hook\n');
      writeFileSync(claudeHookFile, '// drifted claude hook\n');

      // ── (1) plain --apply (no --codex) must NEVER touch ~/.codex ─────────────
      const rNo = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(rNo.status, 0, `claude-only apply failed: ${rNo.stderr}`);
      assert.equal(
        readFileSync(cdxHookFile, 'utf-8'),
        '// drifted codex hook\n',
        'plain --apply (no --codex) must not update the codex hook',
      );
      assert.notEqual(
        readFileSync(claudeHookFile, 'utf-8'),
        '// drifted claude hook\n',
        'plain --apply must update the claude hook (sanity)',
      );

      // ── (2) upgrade --codex (no --apply) must report codex drift in JSON ────
      const rCheck = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--codex', '--json'],
        home,
      );
      assert.equal(rCheck.status, 1, 'codex drift must exit 1 in dry-run');
      const checkJson = JSON.parse(rCheck.stdout);
      assert.ok(
        Array.isArray(checkJson.hooksCodex),
        'JSON output must include hooksCodex when --codex is set',
      );
      assert.ok(
        checkJson.hooksCodex.some((h) => h.file === 'hypo-shared.mjs' && h.status === 'stale'),
        'codex hook drift must be reported as stale',
      );

      // ── (3) upgrade --apply --codex restores the codex hook ─────────────────
      const rApply = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rApply.status, 0, `upgrade --apply --codex failed: ${rApply.stderr}`);
      const applyJson = JSON.parse(rApply.stdout);
      assert.ok(
        applyJson.applied.hooksCodex.includes('hypo-shared.mjs'),
        'codex hook must appear in applied.hooksCodex',
      );
      assert.notEqual(
        readFileSync(cdxHookFile, 'utf-8'),
        '// drifted codex hook\n',
        'codex hook must be restored from the package source',
      );

      // ── (4) idempotency: a second --apply --codex syncs nothing new ─────────
      const rAgain = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rAgain.status, 0, `second --apply --codex failed: ${rAgain.stderr}`);
      const againJson = JSON.parse(rAgain.stdout);
      assert.equal(
        againJson.applied.hooksCodex.length,
        0,
        'idempotent re-apply must not update any codex hook',
      );
      assert.equal(
        againJson.applied.settingsCodex.length,
        0,
        'idempotent re-apply must not register any codex settings entry',
      );
    });
  });
});

// fix #48 — from-scratch case: `init` was run WITHOUT --codex, so ~/.codex does
// not yet exist. `upgrade --apply --codex` must create both ~/.codex/hooks/ and
// register every core hook in ~/.codex/settings.json (mirrors init --codex).
test('upgrade-codex-core-hooks-from-scratch', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      // Claude-only init: ~/.codex must NOT exist beforehand.
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      assert.ok(
        !existsSync(join(home, '.codex', 'hooks')),
        '~/.codex/hooks must not exist before upgrade --codex',
      );

      // upgrade --codex (no --apply) must surface every codex hook as missing.
      const rCheck = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--codex', '--json'],
        home,
      );
      assert.equal(rCheck.status, 1, 'missing codex hooks must exit 1 in dry-run');
      const checkJson = JSON.parse(rCheck.stdout);
      assert.ok(
        checkJson.hooksCodex.length > 0 &&
          checkJson.hooksCodex.every((h) => h.status === 'missing'),
        'every codex hook must be reported as missing before from-scratch apply',
      );
      assert.ok(
        checkJson.settingsCodex.every((s) => s.status === 'missing'),
        'every codex settings registration must be reported as missing',
      );

      // apply: ~/.codex/hooks/ + settings.json get created and registered.
      const rApply = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rApply.status, 0, `upgrade --apply --codex failed: ${rApply.stderr}`);
      const applyJson = JSON.parse(rApply.stdout);

      const cdxHooks = join(home, '.codex', 'hooks');
      assert.ok(existsSync(cdxHooks), '~/.codex/hooks must be created by upgrade --apply --codex');
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-shared.mjs')),
        'core hook must be hard-copied to ~/.codex/hooks',
      );
      assert.ok(
        applyJson.applied.hooksCodex.length > 0,
        'applied.hooksCodex must list the created hooks',
      );

      const cdxSettings = JSON.parse(readFileSync(join(home, '.codex', 'settings.json'), 'utf-8'));
      // The registered command must point at ~/.codex (not ~/.claude) — the
      // mergeSettingsJson path uses the codex hooksDir.
      const allCmds = Object.values(cdxSettings.hooks || {})
        .flatMap((groups) => groups)
        .flatMap((g) => g.hooks || [])
        .map((h) => h.command || '');
      assert.ok(
        allCmds.some((c) => c.includes('$HOME/.codex/hooks/')),
        'codex settings entries must point at ~/.codex/hooks/, not ~/.claude/hooks/',
      );
      assert.ok(
        !allCmds.some((c) => c.includes('$HOME/.claude/hooks/')),
        'codex settings must NOT reference ~/.claude/hooks/',
      );
      assert.ok(
        applyJson.applied.settingsCodex.length > 0,
        'applied.settingsCodex must list the registered events',
      );
    });
  });
});

// fix #48 — the wiki-*.mjs → hypo-*.mjs rename migration (§8.6 line 1103) must
// mirror onto ~/.codex/settings.json too. Simulates a v1.0/v1.1 codex user whose
// codex settings carries a legacy `wiki-shared.mjs` reference: `upgrade --apply
// --codex` should rewrite the command and copy the renamed hook into ~/.codex/hooks/.
test('upgrade-codex-core-hooks-mirror: wiki-*.mjs → hypo-*.mjs rename on codex side', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-git-init', '--codex'],
        home,
      );
      assert.equal(initR.status, 0, `init --codex failed: ${initR.stderr}`);

      // Plant the legacy state: a wiki-shared.mjs file in ~/.codex/hooks/ AND a
      // settings.json entry that still references it. The fresh init carried the
      // new hypo-shared.mjs reference — we replace it with the legacy command so
      // the rename detector has work to do.
      const cdxHooks = join(home, '.codex', 'hooks');
      const cdxSettingsPath = join(home, '.codex', 'settings.json');
      writeFileSync(join(cdxHooks, 'wiki-shared.mjs'), '// legacy v1.1 codex hook\n');

      const cfg = JSON.parse(readFileSync(cdxSettingsPath, 'utf-8'));
      // Pick an event the legacy hook would actually have appeared in (any one is
      // fine — the rename scan walks every event).
      const eventName = Object.keys(cfg.hooks || {})[0] || 'SessionStart';
      cfg.hooks = cfg.hooks || {};
      cfg.hooks[eventName] = cfg.hooks[eventName] || [];
      cfg.hooks[eventName].push({
        hooks: [{ type: 'command', command: 'node $HOME/.codex/hooks/wiki-shared.mjs' }],
      });
      writeFileSync(cdxSettingsPath, JSON.stringify(cfg, null, 2) + '\n');

      // dry-run --codex must surface the codex-side legacy reference.
      const rCheck = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--codex', '--json'],
        home,
      );
      assert.equal(rCheck.status, 1, 'codex legacy hook ref must exit 1 in dry-run');
      const checkJson = JSON.parse(rCheck.stdout);
      assert.ok(
        Array.isArray(checkJson.oldHookRefsCodex) &&
          checkJson.oldHookRefsCodex.some((r) => r.oldName === 'wiki-shared.mjs'),
        'oldHookRefsCodex must include the legacy wiki-shared.mjs reference',
      );

      // apply: the rename rewrites the command AND the renamed hook file appears
      // in ~/.codex/hooks/ (mirrors the claude-side behaviour at upgrade.mjs:386-394).
      const rApply = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rApply.status, 0, `upgrade --apply --codex failed: ${rApply.stderr}`);
      const applyJson = JSON.parse(rApply.stdout);
      assert.ok(
        applyJson.applied.hookNameRenamesCodex.some((r) =>
          r.includes('wiki-shared.mjs → hypo-shared.mjs'),
        ),
        'applied.hookNameRenamesCodex must list the rename',
      );

      const cfgAfter = JSON.parse(readFileSync(cdxSettingsPath, 'utf-8'));
      const allCmds = Object.values(cfgAfter.hooks || {})
        .flatMap((groups) => groups)
        .flatMap((g) => g.hooks || [])
        .map((h) => h.command || '');
      assert.ok(
        !allCmds.some((c) => c.includes('wiki-shared.mjs')),
        'no codex settings entry must still reference wiki-shared.mjs after apply',
      );
      assert.ok(
        allCmds.some((c) => c.includes('$HOME/.codex/hooks/hypo-shared.mjs')),
        'codex settings must now reference $HOME/.codex/hooks/hypo-shared.mjs',
      );
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-shared.mjs')),
        'renamed hypo-shared.mjs must exist in ~/.codex/hooks',
      );
    });
  });
});

// fix #48 BLOCKER (codex 2-worker pre-commit review, 2026-05-23): the precheck
// list from checkSettingsJson can become stale when applyHookNameMigration
// rewrites a legacy `wiki-*.mjs` command to its modern `hypo-*.mjs` form between
// the two passes. Without the per-entry re-check that applySettingsJson now
// performs, the apply pass would append a duplicate hypo-*.mjs entry on top of
// the just-renamed command. Both workers independently reproduced 11 duplicate
// registrations on a wiki-only codex settings file — same silent-corruption
// pattern as fix #47.
test('upgrade-codex-core-hooks-mirror: legacy wiki-only settings yields no duplicate registrations', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-git-init', '--codex'],
        home,
      );
      assert.equal(initR.status, 0, `init --codex failed: ${initR.stderr}`);

      const cdxSettingsPath = join(home, '.codex', 'settings.json');

      // Force a fully-legacy codex state: rewrite every hypo-*.mjs command in
      // codex settings to its wiki-*.mjs predecessor. After this step the codex
      // settings file is in the shape a v1.0/v1.1 user upgrading to v1.2 would
      // have (no hypo-* references at all).
      const cfg = JSON.parse(readFileSync(cdxSettingsPath, 'utf-8'));
      const rewriteMap = {
        'hypo-session-start.mjs': 'wiki-session-start.mjs',
        'hypo-first-prompt.mjs': 'wiki-first-prompt.mjs',
        'hypo-lookup.mjs': 'wiki-lookup.mjs',
        'hypo-compact-guard.mjs': 'wiki-compact-guard.mjs',
        'hypo-auto-stage.mjs': 'wiki-auto-stage.mjs',
        'hypo-hot-rebuild.mjs': 'wiki-hot-rebuild.mjs',
        'hypo-auto-commit.mjs': 'wiki-auto-commit.mjs',
        'hypo-cwd-change.mjs': 'wiki-cwd-change.mjs',
        'hypo-file-watch.mjs': 'wiki-file-watch.mjs',
        'hypo-personal-check.mjs': 'personal-wiki-check.mjs',
      };
      for (const groups of Object.values(cfg.hooks || {})) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of g.hooks || []) {
            for (const [modern, legacy] of Object.entries(rewriteMap)) {
              if ((h.command || '').includes(modern)) {
                h.command = h.command.replace(modern, legacy);
              }
            }
          }
        }
      }
      writeFileSync(cdxSettingsPath, JSON.stringify(cfg, null, 2) + '\n');

      // dry-run --codex must report the legacy refs (the wiki-only state is
      // genuine drift). checkSettingsJson may also report the modern names as
      // "missing" — that is exactly the stale-precheck shape that needs to be
      // self-healed at apply time.
      const rCheck = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--codex', '--json'],
        home,
      );
      assert.equal(rCheck.status, 1, 'wiki-only codex settings must exit 1 in dry-run');
      const checkJson = JSON.parse(rCheck.stdout);
      assert.ok(
        checkJson.oldHookRefsCodex.length >= Object.keys(rewriteMap).length,
        'every legacy ref must be detected in oldHookRefsCodex',
      );

      // apply --codex: the rename rewrites every wiki-* → hypo-*. Without the
      // BLOCKER fix, applySettingsJson would then append a SECOND hypo-* entry
      // for every event (its precheck saw "missing"). With the fix it must
      // self-heal and produce exactly one entry per registration.
      const rApply = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rApply.status, 0, `upgrade --apply --codex failed: ${rApply.stderr}`);

      const cfgAfter = JSON.parse(readFileSync(cdxSettingsPath, 'utf-8'));
      const cmdCounts = new Map();
      for (const groups of Object.values(cfgAfter.hooks || {})) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of g.hooks || []) {
            const cmd = h.command || '';
            cmdCounts.set(cmd, (cmdCounts.get(cmd) || 0) + 1);
          }
        }
      }
      const duplicates = [...cmdCounts.entries()].filter(([, n]) => n > 1);
      assert.equal(
        duplicates.length,
        0,
        `no codex settings command must appear twice after apply — found duplicates: ${JSON.stringify(duplicates)}`,
      );
      // And every modern hook from rewriteMap must appear exactly once.
      for (const modern of Object.keys(rewriteMap)) {
        const count = [...cmdCounts.keys()].filter((c) => c.includes(modern)).length;
        assert.equal(
          count,
          1,
          `${modern} must appear exactly once in codex settings (saw ${count})`,
        );
      }
      // No legacy wiki-*.mjs reference may survive (round-2 worker 1 NIT) — a
      // mutation that drops one rename step would leave a legacy command in
      // place AND append the modern one; the duplicate-only check misses that.
      for (const legacy of Object.values(rewriteMap)) {
        const lingering = [...cmdCounts.keys()].filter((c) => c.includes(legacy));
        assert.equal(
          lingering.length,
          0,
          `no legacy ${legacy} reference must survive apply (found: ${JSON.stringify(lingering)})`,
        );
      }

      // Idempotency: a second --apply --codex syncs nothing new on top.
      const rAgain = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--json'],
        home,
      );
      assert.equal(rAgain.status, 0, `second --apply --codex failed: ${rAgain.stderr}`);
      const againJson = JSON.parse(rAgain.stdout);
      assert.equal(
        againJson.applied.settingsCodex.length,
        0,
        'idempotent re-apply must not add any codex settings entry',
      );
      assert.equal(
        againJson.applied.hookNameRenamesCodex.length,
        0,
        'idempotent re-apply must not re-trigger any codex hook rename',
      );
    });
  });
});

// §8.12 (7) doctor extensions integrity (ADR 0024 E5). Detects
// (a) hard-copy SHA mismatch, (b) settings-entry mismatch + orphan, (c) manifest
// missing (warn) / malformed (fail). Malformed = FAIL is what makes doctor's
// `fails=0` ship gate (§5.1.3) actually cover §8.12-7(c).
test('doctor-extensions-integrity', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const doctorLabel = 'Extensions integrity';
      const findExt = (out) => out.find((c) => c.label === doctorLabel);

      // Author + sync a healthy hook extension.
      writeExt(hypoDir, 'hooks', 'hypo-ext-watch.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const sync = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(sync.status, 0, `sync failed: ${sync.stderr}`);

      // (clean) all consistent → pass.
      let r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      let ext = findExt(JSON.parse(r.stdout));
      assert.ok(ext, 'extensions integrity check not found');
      assert.equal(ext.status, 'pass', `expected pass when consistent: ${ext.detail}`);

      // (a) user edits the installed copy → recorded SHA ≠ on-disk → warn (not fail).
      const installed = join(home, '.claude', 'hooks', 'hypo-ext-watch.mjs');
      writeFileSync(installed, '#!/usr/bin/env node\n// hand-edited\n');
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      ext = findExt(JSON.parse(r.stdout));
      assert.equal(ext.status, 'warn', `SHA drift must warn: ${ext.detail}`);
      assert.ok(/drift/i.test(ext.detail), `drift detail expected: ${ext.detail}`);
      assert.notEqual(r.status, 1, 'a recoverable drift must not fail the doctor gate');

      // (b) restore the copy, then strip the settings entry → expected-missing → warn.
      const resync = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--force-extensions'],
        home,
      );
      assert.equal(resync.status, 0, `resync failed: ${resync.stderr}`);
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter(
        (g) => !(g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-watch.mjs')),
      );
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      ext = findExt(JSON.parse(r.stdout));
      assert.equal(ext.status, 'warn', `missing settings entry must warn: ${ext.detail}`);
      assert.ok(/not registered/i.test(ext.detail), `registration detail expected: ${ext.detail}`);

      // (b-orphan) settings entry whose source extension was removed → warn.
      // E4 excludes hypo-ext-* from the core stale checker, so checkExtensions is
      // the only place this is caught.
      withTmpHome((home2) => {
        const hypoDir2 = join(dir, 'wiki2');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir2}`, '--no-git-init'], home2);
        const s2 = {
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/hypo-ext-gone.mjs' }],
              },
            ],
          },
        };
        writeFileSync(join(home2, '.claude', 'settings.json'), JSON.stringify(s2, null, 2));
        const ro = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir2}`, '--json'], home2);
        const eo = findExt(JSON.parse(ro.stdout));
        assert.equal(eo.status, 'warn', `orphan entry must warn: ${eo.detail}`);
        assert.ok(/orphan/i.test(eo.detail), `orphan detail expected: ${eo.detail}`);
      });

      // (c-warn) hook with no manifest → warn ("will not auto-register").
      withTmpHome((home3) => {
        const hypoDir3 = join(dir, 'wiki3');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir3}`, '--no-git-init'], home3);
        writeExt(hypoDir3, 'hooks', 'hypo-ext-nomani.mjs', '#!/usr/bin/env node\n'); // no manifest
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir3}`, '--apply'], home3);
        const rm = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir3}`, '--json'], home3);
        const em = findExt(JSON.parse(rm.stdout));
        assert.equal(em.status, 'warn', `missing manifest must warn: ${em.detail}`);
        assert.ok(/missing/i.test(em.detail), `missing-manifest detail expected: ${em.detail}`);
        assert.notEqual(rm.status, 1, 'a missing manifest must not fail the gate');
      });

      // (c-fail) malformed manifest → FAIL + non-zero exit (ship gate covers §8.12-7c).
      withTmpHome((home4) => {
        const hypoDir4 = join(dir, 'wiki4');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir4}`, '--no-git-init'], home4);
        const extHooks = join(hypoDir4, 'extensions', 'hooks');
        mkdirSync(extHooks, { recursive: true });
        writeFileSync(join(extHooks, 'hypo-ext-bad.mjs'), '#!/usr/bin/env node\n');
        // Unknown event → parseManifest !ok → malformed → fail.
        writeFileSync(
          join(extHooks, 'hypo-ext-bad.manifest.json'),
          JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
        );
        const rf = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir4}`, '--json'], home4);
        const ef = findExt(JSON.parse(rf.stdout));
        assert.equal(ef.status, 'fail', `malformed manifest must fail: ${ef.detail}`);
        assert.equal(rf.status, 1, 'malformed manifest must fail the doctor gate (exit 1)');
      });

      // (b-shape) command registered but matcher/timeout differs from the manifest.
      // upgrade --apply silently self-heals this (extensions.mjs:544), so doctor is
      // the only surface that reports it (the mismatch E3 deferred to E5).
      withTmpHome((home5) => {
        const hypoDir5 = join(dir, 'wiki5');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir5}`, '--no-git-init'], home5);
        writeExt(hypoDir5, 'hooks', 'hypo-ext-shape.mjs', '#!/usr/bin/env node\n', {
          type: 'hook',
          event: 'PostToolUse',
          matcher: 'Write',
          timeout: 5000,
        });
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir5}`, '--apply'], home5);
        // User hand-edits the matcher in settings.json (recorded SHA path untouched).
        const sp = join(home5, '.claude', 'settings.json');
        const s = JSON.parse(readFileSync(sp, 'utf-8'));
        for (const g of s.hooks.PostToolUse) {
          if ((g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-shape.mjs'))) {
            g.matcher = 'Edit'; // diverge from manifest's "Write"
          }
        }
        writeFileSync(sp, JSON.stringify(s, null, 2));
        const r5 = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir5}`, '--json'], home5);
        const e5 = findExt(JSON.parse(r5.stdout));
        assert.equal(e5.status, 'warn', `settings shape drift must warn: ${e5.detail}`);
        assert.ok(/differs from manifest/i.test(e5.detail), `shape-drift detail: ${e5.detail}`);
      });

      // (b-missing-file) codex 2-worker review: a synced hook whose settings.json was
      // deleted (or has no hooks object) must still warn "not registered" — a matching
      // SHA must not mask the absent registration (§8.12-7(b)). Regression for the
      // pre-fix guard that skipped the entry check unless settings.hooks existed.
      withTmpHome((home6) => {
        const hypoDir6 = join(dir, 'wiki6');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir6}`, '--no-git-init'], home6);
        writeExt(hypoDir6, 'hooks', 'hypo-ext-noreg.mjs', '#!/usr/bin/env node\n', {
          type: 'hook',
          event: 'Stop',
        });
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir6}`, '--apply'], home6);
        // Delete settings.json — the installed copy + recorded SHA still match.
        rmSync(join(home6, '.claude', 'settings.json'), { force: true });
        const r6 = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir6}`, '--json'], home6);
        const e6 = findExt(JSON.parse(r6.stdout));
        assert.equal(e6.status, 'warn', `missing settings.json must still warn: ${e6.detail}`);
        assert.ok(
          /not registered/i.test(e6.detail),
          `not-registered detail expected: ${e6.detail}`,
        );
      });
    });
  });
});

// §8.12 (7) codex target: doctor --codex runs the same integrity check against
// ~/.codex, and skills/agents recorded under claude do not false-flag there.
test('doctor-extensions-integrity: --codex target', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxdoc.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'Stop',
      });
      const sync = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex'],
        home,
      );
      assert.equal(sync.status, 0, `codex sync failed: ${sync.stderr}`);

      // Clean → codex check passes.
      let r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--codex', '--json'], home);
      let ext = JSON.parse(r.stdout).find((c) => c.label === 'Codex extensions integrity');
      assert.ok(ext, 'codex extensions integrity check not found');
      assert.equal(ext.status, 'pass', `expected codex pass: ${ext.detail}`);

      // Edit the installed codex copy → drift warn on the codex target.
      writeFileSync(join(home, '.codex', 'hooks', 'hypo-ext-cdxdoc.mjs'), '// edited\n');
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--codex', '--json'], home);
      ext = JSON.parse(r.stdout).find((c) => c.label === 'Codex extensions integrity');
      assert.equal(ext.status, 'warn', `codex drift must warn: ${ext.detail}`);
    });
  });
});

// ── directory skills: forward-sync (ADR 0063, T2-T5) ──────────────────────────
//
// A real skill is skills/<name>/SKILL.md + a subtree, not a flat .md. These drive
// the whole install → orphan-delete → preserve loop through the real upgrade CLI.

suite('directory skills: forward-sync install + orphan removal');

function writeSkillTree(hypoDir, dirName, files, manifest) {
  const root = join(hypoDir, 'extensions', 'skills', dirName);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (manifest !== undefined) {
    mkdirSync(join(hypoDir, 'extensions', 'skills'), { recursive: true });
    writeFileSync(
      join(hypoDir, 'extensions', 'skills', `${dirName}.manifest.json`),
      JSON.stringify(manifest, null, 2),
    );
  }
  return root;
}

function withSkillWiki(fn) {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const sync = () => {
        const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
        return r;
      };
      const pkgExt = () => {
        const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
        return (pkg.extensions && pkg.extensions.claude) || {};
      };
      fn({ home, hypoDir, sync, pkgExt, skillsDir: join(home, '.claude', 'skills') });
    });
  });
}

test('a directory skill installs its whole subtree under its own name', () => {
  withSkillWiki(({ hypoDir, sync, pkgExt, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
      'scripts/deep/run.sh': 'echo hi\n',
    });
    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);

    // The wiki storage prefix is stripped: the skill installs as the name it is invoked by.
    assert.ok(existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'SKILL.md must install');
    assert.ok(existsSync(join(skillsDir, 'demo', 'references', 'bar.md')), 'subtree must install');
    assert.ok(existsSync(join(skillsDir, 'demo', 'scripts', 'deep', 'run.sh')), 'deep file');
    assert.ok(
      !existsSync(join(skillsDir, 'hypo-ext-demo')),
      'must not install under the wiki name',
    );

    // One single-segment top-level key; the per-file SHAs live in the nested value.
    const ext = pkgExt();
    const val = ext['skills/demo'];
    assert.equal(typeof val, 'object', 'skill value must be a nested map, not a string SHA');
    assert.deepEqual(Object.keys(val).sort(), [
      'SKILL.md',
      'references/bar.md',
      'scripts/deep/run.sh',
    ]);
    assert.ok(/^[0-9a-f]{64}$/.test(val['SKILL.md']));
  });
});

test('a file dropped from the wiki subtree is removed from the install (owned + unmodified)', () => {
  withSkillWiki(({ hypoDir, sync, pkgExt, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();
    assert.ok(existsSync(join(skillsDir, 'demo', 'references', 'bar.md')));

    rmSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references'), {
      recursive: true,
    });
    const r = sync();
    assert.equal(r.status, 0, `re-sync failed: ${r.stderr}`);

    assert.ok(
      !existsSync(join(skillsDir, 'demo', 'references', 'bar.md')),
      'the orphan must be deleted',
    );
    assert.ok(existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'SKILL.md must survive');
    assert.ok(
      !existsSync(join(skillsDir, 'demo', 'references')),
      'the emptied directory must be pruned',
    );
    assert.deepEqual(Object.keys(pkgExt()['skills/demo']), ['SKILL.md']);
  });
});

test('a user-modified orphan is preserved AND stays owned (so --force can still clean it)', () => {
  withSkillWiki(({ hypoDir, sync, pkgExt, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    // The user edits the installed copy, then the wiki drops the file.
    writeFileSync(join(skillsDir, 'demo', 'references', 'bar.md'), 'MY EDITS\n');
    rmSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references'), {
      recursive: true,
    });
    sync();

    assert.equal(
      readFileSync(join(skillsDir, 'demo', 'references', 'bar.md'), 'utf-8'),
      'MY EDITS\n',
      'a user-modified orphan must never be deleted',
    );
    // Dropping the record would make the file unowned — beyond --force-extensions forever.
    assert.ok(
      pkgExt()['skills/demo']['references/bar.md'],
      'the preserved orphan must keep its ownership record',
    );
  });
});

test('a file the user added to the install directory is never touched (unowned)', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', { 'SKILL.md': '# demo\n' });
    sync();

    writeFileSync(join(skillsDir, 'demo', 'notes.md'), 'my own notes\n');
    sync();

    assert.equal(
      readFileSync(join(skillsDir, 'demo', 'notes.md'), 'utf-8'),
      'my own notes\n',
      'an unowned file is not an orphan and must survive',
    );
    assert.ok(!pkgExt()['skills/demo']['notes.md'], 'and we must not claim ownership of it');
  });
});

test('a symlinked directory in the wiki subtree is never followed', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    const root = writeSkillTree(hypoDir, 'hypo-ext-demo', { 'SKILL.md': '# demo\n' });
    // references -> a directory outside the vault holding a secret.
    const outside = join(hypoDir, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.md'), 'SECRET\n');
    symlinkSync(outside, join(root, 'references'));

    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.ok(existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'the real file still installs');
    assert.ok(
      !existsSync(join(skillsDir, 'demo', 'references', 'secret.md')),
      'a symlinked source directory must not be copied through',
    );
    assert.ok(!pkgExt()['skills/demo']['references/secret.md']);
  });
});

test('a directory without a regular SKILL.md is not a skill (skipped, not installed)', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    const root = join(hypoDir, 'extensions', 'skills', 'hypo-ext-nope');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'references', 'x.md'), 'x\n');

    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.ok(!existsSync(join(skillsDir, 'nope')), 'no SKILL.md → not a skill');
    assert.ok(!pkgExt()['skills/nope']);
  });
});

// The headline destructive guard: lexical containment cannot see a symlink in the
// MIDDLE of an install path. Without the lstat ancestor walk, an orphan unlink
// would follow `~/.claude/skills/demo/references -> /outside` and delete a file
// that was never ours. The SHA is made to MATCH on purpose — that is precisely the
// case where every other gate (ownership, containment) says "safe to delete".
test('an orphan is NOT unlinked through a symlinked ancestor in the install path', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    // The wiki drops the file → it becomes an orphan we own and would delete.
    rmSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references'), {
      recursive: true,
    });

    // Swap the installed subdir for a symlink to somewhere outside, holding a file
    // whose bytes hash to the SHA we recorded.
    const outside = join(hypoDir, '..', 'outside-del');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'bar.md'), 'bar\n');
    rmSync(join(skillsDir, 'demo', 'references'), { recursive: true });
    symlinkSync(outside, join(skillsDir, 'demo', 'references'));

    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.ok(
      existsSync(join(outside, 'bar.md')),
      'the unlink must not escape through the symlinked ancestor',
    );
  });
});

test('a copy is NOT written through a symlinked ancestor in the install path', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    // Point the installed subdir at an outside directory, then change the wiki file
    // so sync wants to write it again.
    const outside = join(hypoDir, '..', 'outside-write');
    mkdirSync(outside, { recursive: true });
    rmSync(join(skillsDir, 'demo', 'references'), { recursive: true });
    symlinkSync(outside, join(skillsDir, 'demo', 'references'));
    writeFileSync(
      join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references', 'bar.md'),
      'CHANGED\n',
    );

    const r = sync();
    assert.ok(
      !existsSync(join(outside, 'bar.md')),
      'the copy must not be written out through the symlinked ancestor',
    );
    // A path we cannot safely write is a hard conflict, exactly like a symlinked
    // leaf: it blocks the install loudly rather than being skipped in silence.
    assert.notEqual(r.status, 0, 'an unsafe install path must block, not pass quietly');
    assert.ok(
      (r.stdout + r.stderr).includes('skip-unsafe-path'),
      `the refusal must be reported: ${r.stdout}${r.stderr}`,
    );
  });
});

test('uninstall does not delete through a symlinked ancestor either', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    const outside = join(hypoDir, '..', 'outside-uninstall');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'bar.md'), 'bar\n');
    rmSync(join(skillsDir, 'demo', 'references'), { recursive: true });
    symlinkSync(outside, join(skillsDir, 'demo', 'references'));

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(
      existsSync(join(outside, 'bar.md')),
      'uninstall must not follow a symlinked ancestor out of the skill dir',
    );
  });
});

test('--force-extensions cleans up a preserved (user-modified) orphan', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir, pkgExt }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    writeFileSync(join(skillsDir, 'demo', 'references', 'bar.md'), 'MY EDITS\n');
    rmSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references'), {
      recursive: true,
    });
    sync(); // preserved, still owned

    const r = runWithHome(
      'upgrade.mjs',
      [`--hypo-dir=${hypoDir}`, '--apply', '--force-extensions'],
      home,
    );
    assert.equal(r.status, 0, `force sync failed: ${r.stderr}`);
    assert.ok(
      !existsSync(join(skillsDir, 'demo', 'references', 'bar.md')),
      '--force-extensions must be able to reach the orphan the record kept alive',
    );
    assert.ok(!pkgExt()['skills/demo']['references/bar.md'], 'and drop its record once removed');
  });
});

test('a flat hypo-ext-*.md skill keeps its old install path (no regression)', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    const dir = join(hypoDir, 'extensions', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hypo-ext-flat.md'), '# flat\n');

    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    // The flat shape predates directory skills; its install path must not move.
    assert.ok(existsSync(join(skillsDir, 'hypo-ext-flat.md')), 'flat skill keeps the wiki name');
    assert.equal(
      typeof pkgExt()['skills/hypo-ext-flat.md'],
      'string',
      'a flat key keeps its plain string SHA',
    );
  });
});

test('a sidecar installName overrides the install directory name', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    writeSkillTree(
      hypoDir,
      'hypo-ext-demo',
      { 'SKILL.md': '# demo\n' },
      {
        type: 'skill',
        installName: 'renamed',
      },
    );
    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.ok(existsSync(join(skillsDir, 'renamed', 'SKILL.md')));
    assert.ok(!existsSync(join(skillsDir, 'demo')));
    assert.ok(pkgExt()['skills/renamed']);
  });
});

test('an installName in the reserved hypo namespace is refused, not installed', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    writeSkillTree(
      hypoDir,
      'hypo-ext-demo',
      { 'SKILL.md': '# demo\n' },
      {
        type: 'skill',
        installName: 'hypo-evil',
      },
    );
    sync();
    assert.ok(!existsSync(join(skillsDir, 'hypo-evil')), 'reserved namespace must be refused');
    assert.ok(!existsSync(join(skillsDir, 'demo')), 'and it must not silently fall back');
    assert.deepEqual(
      Object.keys(pkgExt()).filter((k) => k.startsWith('skills/')),
      [],
    );
  });
});

test('a corrupt recorded value (string SHA under a skill key) is ignored, not trusted', () => {
  withSkillWiki(({ home, hypoDir, sync, pkgExt, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', { 'SKILL.md': '# demo\n' });
    sync();

    // Park a flat string SHA under the skill key, as a corrupt pkg-json would.
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.extensions.claude['skills/demo'] = 'f'.repeat(64);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const r = sync();
    assert.equal(r.status, 0, `sync must not crash on a corrupt value: ${r.stderr}`);
    // The bogus value grants no ownership, so nothing is deleted and the map re-forms.
    assert.ok(existsSync(join(skillsDir, 'demo', 'SKILL.md')));
    assert.equal(typeof pkgExt()['skills/demo'], 'object');
  });
});

suite('directory skills: doctor + uninstall see the nested record');

test('doctor reports a healthy skill as clean, and flags a drifted subtree file', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    const check = () => {
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      return JSON.parse(r.stdout).find((c) => c.label === 'Extensions integrity');
    };

    // Before this branch existed, doctor joined `skills/demo` onto the root, hit a
    // DIRECTORY, and warned "not a regular file" on every healthy run.
    assert.equal(check().status, 'pass', `healthy skill must be clean: ${check().detail}`);

    writeFileSync(join(skillsDir, 'demo', 'references', 'bar.md'), 'user edit\n');
    const drifted = check();
    assert.equal(drifted.status, 'warn', 'an edited subtree file must surface as drift');
    assert.ok(
      drifted.detail.includes('references/bar.md'),
      `drift must name the file: ${drifted.detail}`,
    );
  });
});

test('uninstall removes the owned subtree but preserves what it does not own', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
      'references/keep.md': 'keep\n',
    });
    sync();

    // One file the user edited, one they added themselves.
    writeFileSync(join(skillsDir, 'demo', 'references', 'keep.md'), 'MY EDITS\n');
    writeFileSync(join(skillsDir, 'demo', 'mine.md'), 'mine\n');

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}\n${r.stdout}`);

    assert.ok(!existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'owned + unmodified → removed');
    assert.ok(
      !existsSync(join(skillsDir, 'demo', 'references', 'bar.md')),
      'owned subtree file → removed',
    );
    assert.equal(
      readFileSync(join(skillsDir, 'demo', 'references', 'keep.md'), 'utf-8'),
      'MY EDITS\n',
      'user-modified → preserved',
    );
    assert.equal(
      readFileSync(join(skillsDir, 'demo', 'mine.md'), 'utf-8'),
      'mine\n',
      'unowned → preserved',
    );
    // The skill root cannot be pruned while it still holds the files we preserved.
    assert.ok(existsSync(join(skillsDir, 'demo')), 'a dir holding preserved files stays');
  });
});

// codex pre-commit BLOCKER: the guard skipped the boundary dir itself, so
// symlinking ~/.claude/skills — the one ancestor every install path shares —
// bypassed it entirely.
test('a symlinked skills/ boundary directory is itself refused (guard covers the root)', () => {
  withSkillWiki(({ hypoDir, sync, home }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    const skillsDir = join(home, '.claude', 'skills');
    const outside = join(hypoDir, '..', 'outside-boundary');
    mkdirSync(outside, { recursive: true });
    // Move the real tree out and point skills/ at it: every install path now runs
    // through a symlinked ancestor.
    mkdirSync(join(outside, 'demo', 'references'), { recursive: true });
    writeFileSync(join(outside, 'demo', 'SKILL.md'), '# demo\n');
    writeFileSync(join(outside, 'demo', 'references', 'bar.md'), 'bar\n');
    rmSync(skillsDir, { recursive: true });
    symlinkSync(outside, skillsDir);

    rmSync(join(hypoDir, 'extensions', 'skills', 'hypo-ext-demo', 'references'), {
      recursive: true,
    });
    sync();

    assert.ok(
      existsSync(join(outside, 'demo', 'references', 'bar.md')),
      'a symlinked skills/ boundary must not let the orphan unlink through',
    );
  });
});

// codex pre-commit BLOCKER (with a working repro): a corrupt `"skills/x": {}`
// record granted no file ownership, yet uninstall still ran the directory prune —
// which, through a symlinked skill dir, rmdir'd empty directories outside the tree.
test('a corrupt empty skill record grants no pruning power (uninstall)', () => {
  withSkillWiki(({ home, hypoDir, sync }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', { 'SKILL.md': '# demo\n' });
    sync();

    const skillsDir = join(home, '.claude', 'skills');
    const outside = join(hypoDir, '..', 'outside-prune');
    mkdirSync(join(outside, 'victim'), { recursive: true }); // empty → rmdir-able
    rmSync(join(skillsDir, 'demo'), { recursive: true });
    symlinkSync(outside, join(skillsDir, 'demo'));

    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.extensions.claude['skills/demo'] = {}; // owns nothing
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(
      existsSync(join(outside, 'victim')),
      'an empty record must not let uninstall rmdir outside the skill tree',
    );
  });
});

// A partial uninstall must rewrite the record down to exactly what it still owns:
// keep the preserved file (dropping it disowns the file forever) but DROP the files
// it removed. Keeping a removed path is a live data-loss path — see the next test.
test('a partial uninstall rewrites the record to exactly the files it still owns', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/keep.md': 'keep\n',
    });
    sync();
    writeFileSync(join(skillsDir, 'demo', 'references', 'keep.md'), 'MY EDITS\n');

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(existsSync(join(skillsDir, 'demo', 'references', 'keep.md')), 'edited file survives');
    assert.ok(!existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'owned file removed');

    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    assert.ok(existsSync(pkgPath), 'the pkg must survive: a preserved file still needs its record');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const rec = pkg.extensions.claude['skills/demo'];
    assert.deepEqual(
      Object.keys(rec),
      ['references/keep.md'],
      'the record must claim the preserved file and ONLY that',
    );
  });
});

// codex fix-verify BLOCKER (with a working repro): the record kept a stale claim on
// a path uninstall had already removed. Put a NEW file at that path and --force
// deletes it, because --force bypasses the SHA gate and the stale claim points there.
test('a stale record claim cannot make --force delete a file the user later created', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/keep.md': 'keep\n',
    });
    sync();

    // Edit one file so uninstall preserves it and the skill is only partly removed.
    writeFileSync(join(skillsDir, 'demo', 'references', 'keep.md'), 'MY EDITS\n');
    runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.ok(!existsSync(join(skillsDir, 'demo', 'SKILL.md')), 'SKILL.md was removed');

    // The user writes their OWN file at the path we used to own.
    writeFileSync(join(skillsDir, 'demo', 'SKILL.md'), 'USER NEW FILE\n');

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes', '--force-extensions'], home);
    assert.equal(r.status, 0, `force uninstall failed: ${r.stderr}`);
    assert.equal(
      readFileSync(join(skillsDir, 'demo', 'SKILL.md'), 'utf-8'),
      'USER NEW FILE\n',
      'a path we no longer own must not be deletable through a stale record claim',
    );
  });
});

test('a refused (unsafe-path) file keeps the ownership record it already had', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir, pkgExt }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();
    const before = pkgExt()['skills/demo']['references/bar.md'];
    assert.ok(before, 'precondition: the file is owned');

    // Make the install path unsafe, then re-sync: the copy is refused.
    const outside = join(hypoDir, '..', 'outside-refuse');
    mkdirSync(outside, { recursive: true });
    rmSync(join(skillsDir, 'demo', 'references'), { recursive: true });
    symlinkSync(outside, join(skillsDir, 'demo', 'references'));
    runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);

    assert.equal(
      pkgExt()['skills/demo']['references/bar.md'],
      before,
      'refusing to touch a path must not disown what we already installed there',
    );
  });
});

// codex final-review BLOCKER (with a working repro): the nested SHA maps were plain
// objects, so a file literally named `__proto__` assigned through the prototype
// setter instead of creating an own key. The file installed but was never recorded —
// unowned, and uninstall could never remove it. `constructor` had the mirror problem:
// a lookup returned a truthy inherited value as if it were a recorded SHA.
test('a skill file named __proto__ or constructor is tracked, not swallowed by the prototype', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir, pkgExt }) => {
    // Built with a null prototype on purpose: in an object LITERAL, `__proto__:`
    // sets the prototype instead of creating an own key, so the fixture would
    // silently not contain the file we mean to test.
    const files = Object.create(null);
    files['SKILL.md'] = '# demo\n';
    files['__proto__'] = 'proto\n';
    files['constructor'] = 'ctor\n';
    writeSkillTree(hypoDir, 'hypo-ext-demo', files);
    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);

    assert.ok(existsSync(join(skillsDir, 'demo', '__proto__')), '__proto__ installs');
    const rec = pkgExt()['skills/demo'];
    assert.ok(
      Object.prototype.hasOwnProperty.call(rec, '__proto__'),
      '__proto__ must be recorded as an OWN key, or the file is installed but unowned',
    );
    assert.ok(Object.prototype.hasOwnProperty.call(rec, 'constructor'));

    // Being owned is what makes it removable.
    const u = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(u.status, 0, `uninstall failed: ${u.stderr}`);
    assert.ok(
      !existsSync(join(skillsDir, 'demo', '__proto__')),
      'uninstall must be able to reach a file it recorded',
    );
  });
});

test('a case-fold collision DEEP in the subtree still poisons the whole skill', () => {
  withSkillWiki(({ hypoDir, sync, skillsDir, pkgExt }) => {
    const root = writeSkillTree(hypoDir, 'hypo-ext-demo', { 'SKILL.md': '# demo\n' });
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'references', 'A.md'), 'A\n');
    try {
      writeFileSync(join(root, 'references', 'a.md'), 'a\n');
    } catch {
      return; // case-insensitive FS: the clash cannot even be authored here
    }
    // On a case-insensitive FS the two names are one file — nothing to test.
    if (readdirSync(join(root, 'references')).length < 2) return;

    const r = sync();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.ok(
      !pkgExt()['skills/demo'],
      'a collision below the root must skip the whole skill, not just the root level',
    );
    assert.ok(!existsSync(join(skillsDir, 'demo')), 'and nothing may be installed');
  });
});

test('a corrupt object value under a FLAT key grants no ownership (--force cannot use it)', () => {
  withSkillWiki(({ home, hypoDir, sync }) => {
    const dir = join(hypoDir, 'extensions', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hypo-ext-flat.md'), '# flat\n');
    sync();

    const flatPath = join(home, '.claude', 'skills', 'hypo-ext-flat.md');
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.extensions.claude['skills/hypo-ext-flat.md'] = { 'x.md': 'f'.repeat(64) };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes', '--force-extensions'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(
      existsSync(flatPath),
      'a wrong-shaped flat value must not authorize removal, even under --force',
    );
  });
});

test('uninstall prunes the skill directory when nothing is left to preserve', () => {
  withSkillWiki(({ home, hypoDir, sync, skillsDir }) => {
    writeSkillTree(hypoDir, 'hypo-ext-demo', {
      'SKILL.md': '# demo\n',
      'references/bar.md': 'bar\n',
    });
    sync();

    const r = runWithHome('uninstall.mjs', ['--apply', '--yes'], home);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(!existsSync(join(skillsDir, 'demo')), 'a fully-owned skill dir is pruned');
  });
});

// ── extensions settings.json mixed-group surgical write (ADR 0024 amend 2026-05-23) ──
//
// registerSettings used to ignore mixed-group occurrences of our command (any
// group where g.hooks.length > 1) — leaving us either drifted in place or
// duplicated as a fresh append. fix #47 makes the write-path surgical: locate
// every occurrence (single + mixed across every event), rank by 8-step
// priority, pick canonical, drop duplicates, mutate with the lowest-disturbance
// edit. Foreign hooks and the hosting group's matcher are NEVER modified.

suite('extensions settings.json mixed-group surgical write (lib/extensions.mjs, fix #47)');

// Helper: inject a foreign sibling hook into the matcher group that already
// owns our hypo-ext-* command. Returns the path so the test can re-read.
function injectForeignSibling(home, event, ourCmdSubstr, foreignHook) {
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const groups = settings.hooks[event] || [];
  const ourGroupIdx = groups.findIndex((g) =>
    (g.hooks || []).some((h) => (h.command || '').includes(ourCmdSubstr)),
  );
  assert.ok(ourGroupIdx !== -1, `our hook not found in ${event} groups`);
  groups[ourGroupIdx].hooks.push(foreignHook);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settingsPath;
}

test('extensions-settings-mixed-group: foreign sibling preserved, our hook in-place patched on timeout drift (rank 4)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-mixed.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 10000,
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first apply: ${r1.stderr}`);

      // Inject foreign sibling into our matcher group.
      const settingsPath = injectForeignSibling(home, 'PostToolUse', 'hypo-ext-mixed.mjs', {
        type: 'command',
        command: 'node /other/plugin/hook.mjs',
        timeout: 5000,
      });

      // Drift the manifest timeout — same matcher, same event, our hook fields change.
      writeExt(hypoDir, 'hooks', 'hypo-ext-mixed.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 20000,
      });
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second apply: ${r2.stderr}`);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const groups = after.hooks.PostToolUse || [];
      const mixed = groups.find((g) => g.hooks.length === 2);
      assert.ok(mixed, 'mixed group should still exist (foreign + ours)');
      assert.equal(mixed.matcher, 'Write|Edit', 'group matcher untouched');

      const foreign = mixed.hooks.find((h) => h.command === 'node /other/plugin/hook.mjs');
      assert.ok(foreign, 'foreign hook preserved');
      assert.equal(foreign.timeout, 5000, 'foreign timeout never modified');

      const ours = mixed.hooks.find((h) => (h.command || '').includes('hypo-ext-mixed.mjs'));
      assert.ok(ours, 'our hook still in-place inside mixed group');
      assert.equal(ours.timeout, 20000, 'our hook timeout patched in-place');

      const ourSingles = groups.filter(
        (g) => g.hooks.length === 1 && (g.hooks[0].command || '').includes('hypo-ext-mixed.mjs'),
      );
      assert.equal(ourSingles.length, 0, 'no duplicate single-hook group appended');
    });
  });
});

test('extensions-settings-mixed-group: matcher change extracts our hook, foreign keeps original group + matcher (rank 5)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-matcher.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const settingsPath = injectForeignSibling(home, 'PostToolUse', 'hypo-ext-matcher.mjs', {
        type: 'command',
        command: 'node /other/plugin/hook.mjs',
      });

      // Matcher changes: our hook must extract; foreign stays under 'Write'.
      writeExt(hypoDir, 'hooks', 'hypo-ext-matcher.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Edit',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const groups = after.hooks.PostToolUse || [];

      const foreignGroup = groups.find(
        (g) => g.hooks.length === 1 && g.hooks[0].command === 'node /other/plugin/hook.mjs',
      );
      assert.ok(foreignGroup, 'foreign hook left behind in its own single-hook group');
      assert.equal(
        foreignGroup.matcher,
        'Write',
        'foreign group keeps the ORIGINAL matcher (never edited by us)',
      );

      const ourGroup = groups.find(
        (g) => g.hooks.length === 1 && (g.hooks[0].command || '').includes('hypo-ext-matcher.mjs'),
      );
      assert.ok(ourGroup, 'our hook extracted into new single-hook group');
      assert.equal(ourGroup.matcher, 'Edit', 'our new group adopts the manifest matcher');
    });
  });
});

test('extensions-settings-mixed-group: event change extracts our hook, foreign keeps original event (rank 7)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-event.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const settingsPath = injectForeignSibling(home, 'PostToolUse', 'hypo-ext-event.mjs', {
        type: 'command',
        command: 'node /other/plugin/hook.mjs',
      });

      // Event changes from PostToolUse → PreToolUse.
      writeExt(hypoDir, 'hooks', 'hypo-ext-event.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PreToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const post = after.hooks.PostToolUse || [];
      const pre = after.hooks.PreToolUse || [];

      const foreignGroup = post.find(
        (g) => g.hooks.length === 1 && g.hooks[0].command === 'node /other/plugin/hook.mjs',
      );
      assert.ok(foreignGroup, 'foreign hook stays under PostToolUse with the original matcher');
      assert.equal(foreignGroup.matcher, 'Write');

      const ourGroup = pre.find(
        (g) => g.hooks.length === 1 && (g.hooks[0].command || '').includes('hypo-ext-event.mjs'),
      );
      assert.ok(ourGroup, 'our hook moved to PreToolUse single-hook group');
      assert.equal(ourGroup.matcher, 'Write');

      // Ours must NOT be in PostToolUse anymore.
      const stillPost = post.find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-event.mjs')),
      );
      assert.equal(stillPost, undefined, 'our hook fully removed from PostToolUse');
    });
  });
});

test('extensions-settings-multi-occurrence-cleanup: duplicate single + mixed converges to one canonical', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-dup.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      // Hand-corrupt settings: keep the canonical single-hook group AND add a
      // stale mixed-group occurrence under PreToolUse (event drift + foreign).
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
      settings.hooks.PreToolUse.push({
        matcher: 'Edit',
        hooks: [
          { type: 'command', command: 'node /other/plugin/hook.mjs' },
          {
            type: 'command',
            command:
              settings.hooks.PostToolUse[
                settings.hooks.PostToolUse.findIndex((g) =>
                  (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-dup.mjs')),
                )
              ].hooks[0].command,
            timeout: 9999,
          },
        ],
      });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `apply failed: ${r.stderr}`);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // After cleanup: exactly one occurrence of our command, under PostToolUse
      // (the rank-1 canonical), foreign hook in PreToolUse preserved alone.
      const allEvents = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'];
      let ourCount = 0;
      for (const ev of allEvents) {
        for (const g of after.hooks[ev] || []) {
          for (const h of g.hooks || []) {
            if ((h.command || '').includes('hypo-ext-dup.mjs')) ourCount += 1;
          }
        }
      }
      assert.equal(ourCount, 1, 'exactly one canonical occurrence after cleanup');

      const foreignSurvived = (after.hooks.PreToolUse || []).some((g) =>
        (g.hooks || []).some((h) => h.command === 'node /other/plugin/hook.mjs'),
      );
      assert.ok(foreignSurvived, 'foreign hook in PreToolUse preserved');
    });
  });
});

test('extensions-settings-mixed-group-idempotent: second --apply over a mixed-group canonical is a byte-equal no-op', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-idem.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      const settingsPath = injectForeignSibling(home, 'PostToolUse', 'hypo-ext-idem.mjs', {
        type: 'command',
        command: 'node /other/plugin/hook.mjs',
      });

      // First apply over the now-mixed group: rank-2 exact (matcher+hook match).
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      const before = readFileSync(settingsPath, 'utf-8');

      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `idempotent apply: ${r2.stderr}`);
      const after = readFileSync(settingsPath, 'utf-8');
      assert.equal(after, before, 'second apply drifted the file (not byte-equal)');

      const out2 = JSON.parse(r2.stdout);
      assert.equal(
        out2.applied.extensions.settingsChanged,
        false,
        'idempotent apply reports settingsChanged=false',
      );
    });
  });
});

// BLOCKER #1 regression (pre-commit codex 2-worker convergence 2026-05-23):
// reference-based locators must survive cleanup-then-mutate even when an
// earlier same-event group is removed during cleanup. The numeric-index
// locator used to silently overwrite a foreign-only group at the stale index.
test('extensions-settings-cleanup-shift: same-event lower-index duplicate removal preserves foreign-only neighbour (BLOCKER #1)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-shift.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first apply: ${r1.stderr}`);

      // Hand-corrupt: build a settings.json with [corrupt-ours-mixed, canonical-
      // ours-single-drift, foreign-only-group] in that traversal order. cleanup
      // will remove [0] (corrupt mixed has ONLY our hook duplicated), causing a
      // same-event groupIdx shift; with numeric locators the canonical at idx 1
      // would re-point to the foreign-only group at idx 2 (now idx 1 after shift)
      // and silently overwrite it.
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const existing = settings.hooks.PostToolUse.find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-shift.mjs')),
      );
      const ourCommand = existing.hooks.find((h) =>
        (h.command || '').includes('hypo-ext-shift.mjs'),
      ).command;
      // Replace PostToolUse with the staged corrupt layout.
      settings.hooks.PostToolUse = [
        // [0] corrupt: two of our hook in one group (no foreign).
        {
          matcher: 'Edit',
          hooks: [
            { type: 'command', command: ourCommand },
            { type: 'command', command: ourCommand, timeout: 9999 },
          ],
        },
        // [1] canonical ours-single with timeout drift.
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: ourCommand, timeout: 5000 }],
        },
        // [2] foreign-only group — must survive untouched.
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'node /foreign/keep.mjs', timeout: 1234 }],
        },
      ];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `apply must not crash on cleanup-shift: ${r2.stderr}`);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const post = after.hooks.PostToolUse || [];

      // Foreign-only group survives, exactly as-is (no overwrite).
      const foreign = post.find(
        (g) => g.hooks.length === 1 && g.hooks[0].command === 'node /foreign/keep.mjs',
      );
      assert.ok(foreign, 'foreign-only group must survive cleanup-shift');
      assert.equal(foreign.matcher, 'Read', 'foreign matcher untouched');
      assert.equal(foreign.hooks[0].timeout, 1234, 'foreign timeout untouched');

      // Exactly one occurrence of our command remains, with manifest shape.
      let ourCount = 0;
      let ourEntry = null;
      let ourGroup = null;
      for (const g of post) {
        for (const h of g.hooks || []) {
          if (h.command === ourCommand) {
            ourCount += 1;
            ourEntry = h;
            ourGroup = g;
          }
        }
      }
      assert.equal(ourCount, 1, `expected exactly 1 canonical, got ${ourCount}`);
      assert.equal(ourEntry.timeout, 10000, 'canonical entry has manifest timeout');
      assert.equal(ourGroup.matcher, 'Write', 'canonical group has manifest matcher');
    });
  });
});

test('doctor-extensions-mixed-group-ownership: doctor accepts mixed-group occurrence (no false "not registered")', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-doctor.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      injectForeignSibling(home, 'PostToolUse', 'hypo-ext-doctor.mjs', {
        type: 'command',
        command: 'node /other/plugin/hook.mjs',
      });

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      assert.equal(r.status, 0, `doctor exit: ${r.stderr}`);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      assert.ok(ext, 'extensions integrity check missing');
      // Doctor must NOT warn `hypo-ext-doctor.mjs not registered` — the
      // mixed-group occurrence is valid ownership under fix #47.
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/hypo-ext-doctor\.mjs not registered/.test(detail),
        `doctor falsely reported not-registered: ${detail}`,
      );
    });
  });
});

// fix #47 follow-up (CONCERN 1, doctor canonical-pick mirror):
// doctor used to `.find(o => o.event === entry.event)` — picks the FIRST
// traversal-order occurrence under the target event. registerSettings picks
// the LOWEST-RANK occurrence (across all events). When the target event has
// a drifted occurrence FIRST and an exact occurrence LATER, pre-fix doctor
// warned "differs" while upgrade --apply was a no-op for the canonical.
// Post-fix doctor uses pickCanonicalOccurrence (same helper as the write
// path) and pass-throughs rank 1/2.
test('doctor-extensions-canonical-mirror: drifted-first + exact-later does NOT warn `differs` (CONCERN 1)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-canon.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      // Hand-corrupt: under PostToolUse keep the canonical exact-shape group
      // (rank 1) AND prepend a drifted single-hook group of our command (rank
      // 3 — wrong timeout). registerSettings picks the later rank-1; doctor
      // must agree, not warn "differs" on the earlier rank-3.
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const exactGroup = settings.hooks.PostToolUse.find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-canon.mjs')),
      );
      const ourCommand = exactGroup.hooks.find((h) =>
        (h.command || '').includes('hypo-ext-canon.mjs'),
      ).command;
      // Drifted single-hook group FIRST (rank 3 — same matcher, wrong timeout)
      settings.hooks.PostToolUse = [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: ourCommand, timeout: 5000 }],
        },
        // Exact canonical group SECOND (rank 1)
        exactGroup,
      ];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      assert.ok(ext, 'extensions integrity check missing');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/hypo-ext-canon settings entry differs/.test(detail),
        `doctor falsely reported differs against drifted earlier occurrence: ${detail}`,
      );
      // It should still surface the duplicate (rank-1 canonical + rank-3 dup
      // = 2 occurrences) so the user is told to run upgrade --apply.
      assert.ok(
        /hypo-ext-canon has 2 occurrences/.test(detail),
        `doctor must surface duplicate-occurrence cleanup work: ${detail}`,
      );
    });
  });
});

test('doctor-extensions-canonical-mirror: target-drift beats non-target-exact (rank 3 < rank 6) → warn `differs`', () => {
  // Cross-event reviewer convergence (codex 2-worker pre-commit): the
  // rank-3 occurrence under the TARGET event must beat a rank-6 exact-shape
  // occurrence under a NON-target event, and doctor must surface "differs"
  // (not "not registered"). Locks the semantics doctor and registerSettings
  // share.
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-xevent.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const exactGroup = settings.hooks.PostToolUse.find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-xevent.mjs')),
      );
      const ourCommand = exactGroup.hooks.find((h) =>
        (h.command || '').includes('hypo-ext-xevent.mjs'),
      ).command;

      // Replace target event with a DRIFTED single-hook (rank 3) and add the
      // EXACT-shape group under PreToolUse (rank 6 — wrong event). Doctor must
      // pick rank 3 as canonical and warn "differs", not "not registered".
      settings.hooks.PostToolUse = [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: ourCommand, timeout: 5000 }],
        },
      ];
      settings.hooks.PreToolUse = [exactGroup];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /hypo-ext-xevent settings entry differs/.test(detail),
        `doctor must warn "differs" on target-drift even with non-target exact: ${detail}`,
      );
      assert.ok(
        !/hypo-ext-xevent not registered/.test(detail),
        `doctor must NOT warn "not registered" — target-rank-3 outranks non-target-rank-6: ${detail}`,
      );
    });
  });
});

test('doctor-extensions-canonical-mirror: rank-1 alone is silent (no false dup warn)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-clean.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 10000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/hypo-ext-clean/.test(detail),
        `clean install must not surface any ext warn: ${detail}`,
      );
    });
  });
});

// fix #47 follow-up (CONCERN 2, empty matcher normalization):
// parseManifest accepted `matcher: ""` as valid, but downstream `if
// (entry.matcher)` silently dropped it from desiredGroup — a semantic
// collapse where the manifest's expressed-empty matcher was treated as
// "absent". Fix: normalize `""` → undefined at the boundary (parseManifest)
// so EVERY consumer (rankOccurrence, registerSettings, doctor) agrees.
test('parseManifest-empty-matcher: matcher:"" is normalized to undefined (CONCERN 2)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-empty.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PreToolUse',
        matcher: '',
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first apply: ${r1.stderr}`);

      const settingsPath = join(home, '.claude', 'settings.json');
      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const ourGroup = (after.hooks.PreToolUse || []).find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-empty.mjs')),
      );
      assert.ok(ourGroup, 'our hook must be registered');
      assert.ok(
        !('matcher' in ourGroup),
        `matcher:"" should be normalized to absent, got: ${JSON.stringify(ourGroup.matcher)}`,
      );

      // Idempotent: byte-equal on a second --apply
      const before = readFileSync(settingsPath, 'utf-8');
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second apply: ${r2.stderr}`);
      assert.equal(readFileSync(settingsPath, 'utf-8'), before, 'second apply byte-equal no-op');

      // doctor must agree — no `differs` warn for the empty-matcher entry
      const dr = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(dr.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/hypo-ext-empty/.test(detail),
        `doctor falsely warned on empty-matcher entry: ${detail}`,
      );
    });
  });
});

// Doctor must surface a
// hypo-ext-* settings.json entry whose source file is present but whose
// manifest is malformed or non-hook (registrable:false). The pre-existing
// orphan scan only matched source-removed cases — manifest-unregistrable
// entries lingered silently because:
//   - (b) `expected` loop skips them (no entry produced)
//   - (c) manifest-health loop only FAILs/warns the manifest itself
//   - orphan scan considered the source file presence sufficient
// Distinct message ("manifest unregistrable") so the user knows it's the
// manifest, not a missing file, that needs attention.
test('doctor-extensions: malformed manifest + lingering settings entry → unregistrable orphan warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Healthy first, then break the manifest after the settings entry exists.
      writeExt(hypoDir, 'hooks', 'hypo-ext-broken.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Now corrupt the manifest — unknown event ⇒ parseManifest !ok ⇒ malformed.
      const extHooks = join(hypoDir, 'extensions', 'hooks');
      writeFileSync(
        join(extHooks, 'hypo-ext-broken.manifest.json'),
        JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
      );

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*hypo-ext-broken.*manifest unregistrable/i.test(detail),
        `expected unregistrable-orphan warn naming settings entry: ${detail}`,
      );
      assert.ok(
        !/orphan settings entry .*hypo-ext-broken.*source extension removed/i.test(detail),
        `must not use source-removed phrasing when source is present: ${detail}`,
      );
    });
  });
});

test('doctor-extensions: non-hook manifest + lingering settings entry → unregistrable orphan warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Hand-place source file + non-hook manifest (type:"skill" under hooks/) +
      // pre-existing settings entry pointing at it. parseManifest returns
      // ok:true, registrable:false — entry orphaned by manifest change.
      const extHooks = join(hypoDir, 'extensions', 'hooks');
      mkdirSync(extHooks, { recursive: true });
      writeFileSync(join(extHooks, 'hypo-ext-skillish.mjs'), '#!/usr/bin/env node\n');
      writeFileSync(
        join(extHooks, 'hypo-ext-skillish.manifest.json'),
        JSON.stringify({ type: 'skill' }),
      );
      const settingsPath = join(home, '.claude', 'settings.json');
      const seed = {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'node $HOME/.claude/hooks/hypo-ext-skillish.mjs' },
              ],
            },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(seed, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*hypo-ext-skillish.*manifest unregistrable/i.test(detail),
        `expected unregistrable-orphan warn (non-hook manifest): ${detail}`,
      );
    });
  });
});

// P2/F1: doctor must recognize a reverse-captured hook registered under its
// ORIGINAL name (installName) as healthy. Its command carries no hypo-ext-*
// marker, so the orphan prefilter widens via the recorded owned-command set,
// while the resolved sourceCmds (cmdFor now uses resolveInstallFile +
// buildHookCommand) must exclude it. If sourceCmds and the widened prefilter ever
// slip out of sync, a perfectly healthy captured hook is false-flagged as a
// source-removed orphan; this positive case pins them together.
test('doctor-extensions: healthy installName-captured hook is not flagged', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cap.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'mycap',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/orphan settings entry/i.test(detail),
        `must not orphan a healthy captured hook: ${detail}`,
      );
      assert.equal(ext.status, 'pass', `expected clean extensions check: ${detail}`);
    });
  });
});

// A captured installName hook whose manifest is later corrupted still has its wiki
// SOURCE present, so doctor must classify the lingering settings entry as
// unregistrable, not "source extension removed" (codex pre-commit CONCERN).
// resolveInstallFile falls back to the wiki name on a broken manifest, so the fix
// recovers the real registered command by matching the source SHA against the
// recorded owned-set (the wiki storage stem `hypo-ext-cap` deliberately differs
// from the installName `mycap`, so a name-convention shortcut would not suffice).
test('doctor-extensions: manifest-invalid installName hook is unregistrable, not source-removed', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Sync healthy so the installName command + recorded ownership exist.
      writeExt(hypoDir, 'hooks', 'hypo-ext-cap.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'mycap',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Corrupt the manifest after the settings entry + recorded keys exist.
      writeFileSync(
        join(hypoDir, 'extensions', 'hooks', 'hypo-ext-cap.manifest.json'),
        JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
      );

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/orphan settings entry .*mycap\.mjs.*source extension removed/i.test(detail),
        `must not use source-removed phrasing when source is present: ${detail}`,
      );
      assert.ok(
        /orphan settings entry .*mycap\.mjs.*manifest unregistrable/i.test(detail),
        `expected unregistrable-orphan warn for the installName command: ${detail}`,
      );
    });
  });
});

// P2: a reverse-captured hook whose wiki source is gone but whose settings entry
// and recorded SHA key remain must be caught as a source-removed orphan under its
// ORIGINAL name: the recorded owned-command set drives the prefilter, the
// resolved sourceCmds (now empty) drives the classification.
test('doctor-extensions: source-removed installName-captured hook → orphan warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cap.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'mycap',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Remove the wiki source (+ manifest) so the settings entry and recorded SHA
      // key are the only trace left, the source-removed orphan case.
      const extHooks = join(hypoDir, 'extensions', 'hooks');
      rmSync(join(extHooks, 'hypo-ext-cap.mjs'));
      rmSync(join(extHooks, 'hypo-ext-cap.manifest.json'));

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*mycap\.mjs.*source extension removed/i.test(detail),
        `expected source-removed orphan naming the original-name command: ${detail}`,
      );
    });
  });
});

// The source-SHA linkage that recovers a malformed hook's real registered command
// must only fire when the SHA uniquely names one recorded install key. The pkg map
// stores the source SHA but not the source identity, so a source-removed hook and a
// malformed hook whose `.mjs` bytes are IDENTICAL share one SHA. Applying the
// linkage to that ambiguous pair would misreport the source-removed hook as
// "manifest unregistrable" (codex fix re-review CONCERN). Assert the source-removed
// hook stays classified as source-removed and never leaks into unregistrable.
test('doctor-extensions: identical-content source-removed + malformed hooks keep distinct classes', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Two hooks with byte-identical .mjs source but different installNames, so
      // their recorded `.mjs` keys carry the same SHA.
      const body = '#!/usr/bin/env node\n';
      writeExt(hypoDir, 'hooks', 'hypo-ext-gone.mjs', body, {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'gonehook',
      });
      writeExt(hypoDir, 'hooks', 'hypo-ext-bad.mjs', body, {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'badhook',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      const extHooks = join(hypoDir, 'extensions', 'hooks');
      // Hook A: source removed (settings entry + recorded key remain).
      rmSync(join(extHooks, 'hypo-ext-gone.mjs'));
      rmSync(join(extHooks, 'hypo-ext-gone.manifest.json'));
      // Hook B: source present, manifest corrupted → drives the SHA-linkage scan.
      writeFileSync(
        join(extHooks, 'hypo-ext-bad.manifest.json'),
        JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
      );

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*gonehook\.mjs.*source extension removed/i.test(detail),
        `source-removed hook must stay source-removed: ${detail}`,
      );
      assert.ok(
        !/orphan settings entry .*gonehook\.mjs.*manifest unregistrable/i.test(detail),
        `ambiguous SHA must not reclassify the source-removed hook as unregistrable: ${detail}`,
      );
    });
  });
});

// Accepted boundary (plan §"리스크"): a captured hook carries no in-command
// ownership marker (unlike hypo-ext-*). Once BOTH the source and the recorded SHA
// key are hand-removed, the lingering settings entry can no longer be classified.
// This mirrors the pre-existing hand-edited-state limit and is fixed as an
// accepted behavior: capture always leaves a recorded key, so the normal path
// still detects it. No fabricated marker.
test('doctor-extensions: captured hook entry unclassified when source + key both gone', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cap.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'mycap',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      const extHooks = join(hypoDir, 'extensions', 'hooks');
      rmSync(join(extHooks, 'hypo-ext-cap.mjs'));
      rmSync(join(extHooks, 'hypo-ext-cap.manifest.json'));
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      delete pkg.extensions.claude['hooks/mycap.mjs'];
      delete pkg.extensions.claude['hooks/mycap.manifest.json'];
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        !/orphan settings entry .*mycap/i.test(detail),
        `accepted boundary: without the recorded key the entry is not classified: ${detail}`,
      );
    });
  });
});

// Orphan duplicate scan. A single
// hypo-ext-* command can appear in multiple groups/events when settings.json
// was hand-edited. Pre-fix the orphan loop deduped by command and emitted a
// single warn, hiding the duplicate count from the user. The fix counts
// occurrences and appends `(N occurrences)`.
test('doctor-extensions: source-removed orphan with 2 occurrences reports count', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Healthy install, then delete the source so it becomes an orphan.
      writeExt(hypoDir, 'hooks', 'hypo-ext-dup.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Hand-edit settings.json to also register the same command under Stop —
      // simulates manual migration leaving a second copy behind.
      const settingsPath = join(home, '.claude', 'settings.json');
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      let extHook = null;
      for (const groups of Object.values(s.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const h of g.hooks || []) {
            if (typeof h.command === 'string' && /hypo-ext-[^/\s]+\.mjs/.test(h.command)) {
              extHook = h;
              break;
            }
          }
          if (extHook) break;
        }
        if (extHook) break;
      }
      assert.ok(extHook, 'ext hook must be registered before duplicating');
      s.hooks.Stop = [{ hooks: [{ ...extHook }] }];
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');

      // Remove BOTH source file AND the extensions/ directory entry so the
      // command becomes orphan everywhere.
      const extHooks = join(hypoDir, 'extensions', 'hooks');
      rmSync(join(extHooks, 'hypo-ext-dup.mjs'));
      rmSync(join(extHooks, 'hypo-ext-dup.manifest.json'));

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*hypo-ext-dup.*source extension removed \(2 occurrences\)/i.test(
          detail,
        ),
        `expected source-removed orphan warn with (2 occurrences): ${detail}`,
      );
    });
  });
});

test('doctor-extensions: unregistrable orphan with 2 occurrences reports count', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      writeExt(hypoDir, 'hooks', 'hypo-ext-dupbad.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Duplicate the settings entry under Stop.
      const settingsPath = join(home, '.claude', 'settings.json');
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      let extHook = null;
      for (const groups of Object.values(s.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const h of g.hooks || []) {
            if (typeof h.command === 'string' && /hypo-ext-[^/\s]+\.mjs/.test(h.command)) {
              extHook = h;
              break;
            }
          }
          if (extHook) break;
        }
        if (extHook) break;
      }
      assert.ok(extHook, 'ext hook must be registered before duplicating');
      s.hooks.Stop = [{ hooks: [{ ...extHook }] }];
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');

      // Corrupt the manifest — source still present but unregistrable.
      const extHooks = join(hypoDir, 'extensions', 'hooks');
      writeFileSync(
        join(extHooks, 'hypo-ext-dupbad.manifest.json'),
        JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
      );

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /orphan settings entry .*hypo-ext-dupbad.*manifest unregistrable \(2 occurrences\)/i.test(
          detail,
        ),
        `expected unregistrable orphan warn with (2 occurrences): ${detail}`,
      );
    });
  });
});

// Hand-edited settings.json with
// `matcher: ""` against a manifest with no matcher. extensions.mjs:178
// normalizes only the manifest side; the settings side still mismatches at
// rankOccurrence (rank 3). Pre-fix doctor lumped this into the generic
// `differs (matcher/timeout)` warn — opaque since "" looks identical to
// absent in casual reading. Fix: dedicated message naming the empty-string
// equivalence so the user knows --apply will normalize it.
test('doctor-extensions: hand-edited matcher:"" surfaces specific normalize-drift message', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Manifest has NO matcher.
      writeExt(hypoDir, 'hooks', 'hypo-ext-emptydrift.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PreToolUse',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Hand-edit: set matcher to "" on our group (settings drift only).
      const settingsPath = join(home, '.claude', 'settings.json');
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      for (const g of s.hooks.PreToolUse || []) {
        if ((g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-emptydrift.mjs'))) {
          g.matcher = '';
        }
      }
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      assert.ok(
        /hypo-ext-emptydrift settings has matcher: "" \(equivalent to absent\)/.test(detail),
        `expected specific empty-matcher normalize msg: ${detail}`,
      );
      assert.ok(
        !/hypo-ext-emptydrift settings entry differs from manifest/.test(detail),
        `must NOT use the generic differs msg for this case: ${detail}`,
      );
    });
  });
});

// The matcher:"" specific message must
// only fire when the hook itself is also exact — otherwise a co-occurring
// timeout (or hook field) drift gets hidden behind the empty-matcher blurb.
// Fix gates the specific message on hookExact; this test plants matcher:""
// AND a wrong timeout, then asserts the generic differs message is used
// (not the normalize-only one), so the user is told about the timeout drift.
test('doctor-extensions: matcher:"" + wrong timeout falls back to generic differs (hookExact gate)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);

      // Manifest has NO matcher but DOES have a timeout (5s).
      writeExt(hypoDir, 'hooks', 'hypo-ext-emptyplustimeout.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PreToolUse',
        timeout: 5,
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `apply: ${up.stderr}`);

      // Hand-edit settings: matcher:"" AND timeout wrong (99 vs manifest 5).
      const settingsPath = join(home, '.claude', 'settings.json');
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      for (const g of s.hooks.PreToolUse || []) {
        for (const h of g.hooks || []) {
          if ((h.command || '').includes('hypo-ext-emptyplustimeout.mjs')) {
            g.matcher = '';
            h.timeout = 99;
          }
        }
      }
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');

      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const checks = JSON.parse(r.stdout);
      const ext = checks.find((c) => c.label === 'Extensions integrity');
      const detail = (ext.detail || '').toString();
      // Generic differs message (now widened to matcher/hook/timeout) MUST fire.
      assert.ok(
        /hypo-ext-emptyplustimeout settings entry differs from manifest/.test(detail),
        `expected generic differs msg when hook drifted too: ${detail}`,
      );
      // The specific normalize-only message MUST NOT fire — that would hide
      // the timeout drift from the user.
      assert.ok(
        !/hypo-ext-emptyplustimeout settings has matcher: "" \(equivalent to absent\)/.test(detail),
        `must NOT use normalize-only msg when hook also drifted: ${detail}`,
      );
    });
  });
});

// ── extensions companion uninstall (ADR 0024) ───────────────────────

suite('extensions companion uninstall (uninstall.mjs, ADR 0024)');

// §8.12 (d): uninstall removes hard-copies + manifests + slash-command exts +
// settings entries, while preserving the wiki source AND any foreign plugin
// entries in settings.json (§7.3 invariant).
test('uninstall-removes-extensions-copy-preserves-source', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-mywatcher.mjs', '#!/usr/bin/env node\n// ours\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-mycmd.md', '# my command\n');

      // Install: hard-copy + manifest + settings entry + pkg SHA.
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `upgrade --apply failed: ${up.stderr}`);

      // Pre-inject a foreign plugin's PostToolUse entry — uninstall MUST preserve it.
      const settingsPath = join(home, '.claude', 'settings.json');
      const seedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      seedSettings.hooks ??= {};
      seedSettings.hooks.PostToolUse ??= [];
      seedSettings.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: 'node /opt/other-plugin/foo.mjs' }],
      });
      writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2) + '\n');

      const hookCopy = join(home, '.claude', 'hooks', 'hypo-ext-mywatcher.mjs');
      const manifestCopy = join(home, '.claude', 'hooks', 'hypo-ext-mywatcher.manifest.json');
      const commandCopy = join(home, '.claude', 'commands', 'hypo-ext-mycmd.md');
      assert.ok(existsSync(hookCopy), 'pre-state: hook copy must exist');
      assert.ok(existsSync(manifestCopy), 'pre-state: manifest copy must exist');
      assert.ok(existsSync(commandCopy), 'pre-state: command copy must exist');

      // Uninstall --apply (claude target only).
      const un = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(un.status, 0, `uninstall failed: ${un.stderr}\n${un.stdout}`);

      // Hard-copies + manifest + slash-command ext are gone.
      assert.ok(!existsSync(hookCopy), 'hook copy must be removed');
      assert.ok(!existsSync(manifestCopy), 'manifest copy must be removed');
      assert.ok(!existsSync(commandCopy), 'command copy must be removed');

      // Wiki source (~/hypomnema/extensions/) is preserved end-to-end.
      assert.ok(
        existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-mywatcher.mjs')),
        'wiki source hook must be preserved',
      );
      assert.ok(
        existsSync(join(hypoDir, 'extensions', 'hooks', 'hypo-ext-mywatcher.manifest.json')),
        'wiki source manifest must be preserved',
      );
      assert.ok(
        existsSync(join(hypoDir, 'extensions', 'commands', 'hypo-ext-mycmd.md')),
        'wiki source command must be preserved',
      );

      // settings.json: hypo-ext-* entries stripped; foreign plugin entry preserved.
      const post = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const flat = JSON.stringify(post.hooks || {});
      assert.ok(!flat.includes('hypo-ext-mywatcher'), 'hypo-ext settings entry must be stripped');
      assert.ok(
        flat.includes('/opt/other-plugin/foo.mjs'),
        'foreign plugin entry must be preserved (§7.3 invariant)',
      );

      // pkg.json: per-target ext map either dropped or has no entries for the removed files.
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const m = (pkg.extensions && pkg.extensions.claude) || {};
        assert.ok(
          !('hooks/hypo-ext-mywatcher.mjs' in m),
          'hook SHA must be stripped from pkg.extensions.claude',
        );
        assert.ok(
          !('hooks/hypo-ext-mywatcher.manifest.json' in m),
          'manifest SHA must be stripped from pkg.extensions.claude',
        );
        assert.ok(
          !('commands/hypo-ext-mycmd.md' in m),
          'command SHA must be stripped from pkg.extensions.claude',
        );
      }
    });
  });
});

// P2: a reverse-captured hook registered under its ORIGINAL name (no hypo-ext-*
// prefix) must still be fully uninstalled. The settings entry is caught by the
// recorded owned-command union (not the prefix), the file by its recorded SHA key.
test('uninstall-removes-installName-captured-hook-settings-and-file', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cap.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        installName: 'mycap',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `upgrade --apply failed: ${up.stderr}`);

      const settingsPath = join(home, '.claude', 'settings.json');
      const hookCopy = join(home, '.claude', 'hooks', 'mycap.mjs');
      const capCommand = 'node $HOME/.claude/hooks/mycap.mjs';

      // Pre-state: installed under the original name, registered with no prefix.
      assert.ok(existsSync(hookCopy), 'pre-state: captured hook copy must exist');
      assert.ok(
        JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks).includes(capCommand),
        'pre-state: original-name command must be registered',
      );

      // Foreign entry that uninstall MUST preserve.
      const seed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      seed.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: 'node /opt/other/foo.mjs' }],
      });
      writeFileSync(settingsPath, JSON.stringify(seed, null, 2) + '\n');

      const un = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(un.status, 0, `uninstall failed: ${un.stderr}\n${un.stdout}`);

      // File removed (recorded key), settings entry stripped (owned-command union).
      assert.ok(!existsSync(hookCopy), 'captured hook file must be removed');
      const post = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks || {});
      assert.ok(!post.includes('mycap.mjs'), 'original-name settings entry must be stripped');
      assert.ok(post.includes('/opt/other/foo.mjs'), 'foreign entry must be preserved');
    });
  });
});

// Boost #6 (plan §5 PR-E6): pre-E6 the codex uninstall branch only stripped
// ~/.codex/hooks + settings, leaving ~/.codex/commands/hypo-ext-*.md orphaned.
// E6 must clean BOTH directories in one --codex pass.
test('uninstall-extensions-codex-removes-both-hooks-and-commands', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxun.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-cdxuncmd.md', '# codex cmd\n');

      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(up.status, 0, `upgrade --apply --codex failed: ${up.stderr}`);

      const cdxHook = join(home, '.codex', 'hooks', 'hypo-ext-cdxun.mjs');
      const cdxCmd = join(home, '.codex', 'commands', 'hypo-ext-cdxuncmd.md');
      const claudeHook = join(home, '.claude', 'hooks', 'hypo-ext-cdxun.mjs');
      const claudeCmd = join(home, '.claude', 'commands', 'hypo-ext-cdxuncmd.md');
      assert.ok(existsSync(cdxHook), 'pre-state: codex hook copy must exist');
      assert.ok(existsSync(cdxCmd), 'pre-state: codex command copy must exist');
      assert.ok(existsSync(claudeHook), 'pre-state: claude hook copy must exist');
      assert.ok(existsSync(claudeCmd), 'pre-state: claude command copy must exist');

      const un = runWithHome('uninstall.mjs', ['--apply', '--codex'], home);
      assert.equal(un.status, 0, `uninstall failed: ${un.stderr}\n${un.stdout}`);

      // The boost #6 assertion: BOTH codex hooks AND codex commands cleaned.
      assert.ok(!existsSync(cdxHook), 'codex hook copy must be removed');
      assert.ok(!existsSync(cdxCmd), 'codex command copy must be removed (boost #6 gap)');
      assert.ok(!existsSync(claudeHook), 'claude hook copy must be removed');
      assert.ok(!existsSync(claudeCmd), 'claude command copy must be removed');

      // ~/.codex/settings.json must no longer carry the ext entry.
      const cdxSettingsPath = join(home, '.codex', 'settings.json');
      if (existsSync(cdxSettingsPath)) {
        const cdxSettings = JSON.parse(readFileSync(cdxSettingsPath, 'utf-8'));
        const flat = JSON.stringify(cdxSettings.hooks || {});
        assert.ok(!flat.includes('hypo-ext-cdxun'), 'codex settings ext entry must be stripped');
      }

      // pkg.json: per-target maps for both claude AND codex must be cleared.
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const claude = (pkg.extensions && pkg.extensions.claude) || {};
        const codex = (pkg.extensions && pkg.extensions.codex) || {};
        assert.ok(!('hooks/hypo-ext-cdxun.mjs' in codex), 'codex hook SHA must be stripped');
        assert.ok(
          !('commands/hypo-ext-cdxuncmd.md' in codex),
          'codex command SHA must be stripped',
        );
        assert.ok(!('hooks/hypo-ext-cdxun.mjs' in claude), 'claude hook SHA must be stripped');
      }
    });
  });
});

// Parity with --force-commands: a user-modified hypo-ext-* file is preserved
// (with a `skippedUserModified` report) unless --force-extensions is passed.
// pkg.json keeps the recorded SHA for the preserved file so doctor still has
// a baseline next run.
test('uninstall-extensions-preserves-user-modified-without-force', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      writeExt(hypoDir, 'hooks', 'hypo-ext-edited.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'Stop',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `upgrade failed: ${up.stderr}`);

      // Locally edit the installed copy so the on-disk SHA diverges from the recorded one.
      const target = join(home, '.claude', 'hooks', 'hypo-ext-edited.mjs');
      writeFileSync(target, '// user-edited locally — must be preserved\n');

      // No --force-extensions → preserved + report mentions preservation.
      const un1 = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(un1.status, 0, `uninstall failed: ${un1.stderr}\n${un1.stdout}`);
      assert.ok(
        existsSync(target),
        'user-modified ext file must be preserved without --force-extensions',
      );
      assert.ok(
        un1.stdout.includes('--force-extensions'),
        `report must mention --force-extensions guidance: ${un1.stdout}`,
      );

      // pkg.json keeps the SHA for the preserved file (doctor needs a baseline).
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const pkg1 = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.ok(
        pkg1.extensions?.claude?.['hooks/hypo-ext-edited.mjs'],
        'pkg SHA must be retained for the preserved file',
      );

      // With --force-extensions → file removed + pkg entry cleared.
      const un2 = runWithHome('uninstall.mjs', ['--apply', '--force-extensions'], home);
      assert.equal(un2.status, 0, `force uninstall failed: ${un2.stderr}\n${un2.stdout}`);
      assert.ok(!existsSync(target), '--force-extensions must remove the user-modified file');
      if (existsSync(pkgPath)) {
        const pkg2 = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        assert.ok(
          !pkg2.extensions?.claude?.['hooks/hypo-ext-edited.mjs'],
          '--force-extensions must clear the pkg SHA after removal',
        );
      }
    });
  });
});

// Per-target SHA contract (plan D2b): a Claude-only uninstall MUST NOT wipe
// ~/.claude/hypo-pkg.json when ~/.codex/hooks/hypo-ext-*.mjs is still in place
// (its ownership baseline lives in `extensions.codex` and must survive).
// Regression cited by the codex pre-commit reviewer: without the
// unprocessed-target guard, a claude-only uninstall would wholesale-rm pkg.json
// and orphan the Codex copies.
test('uninstall-extensions-claude-only-preserves-codex-state', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxonly.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-cdxcmd.md', '# codex cmd\n');

      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(up.status, 0, `upgrade --apply --codex failed: ${up.stderr}`);

      const codexHook = join(home, '.codex', 'hooks', 'hypo-ext-cdxonly.mjs');
      const codexCmd = join(home, '.codex', 'commands', 'hypo-ext-cdxcmd.md');
      assert.ok(existsSync(codexHook), 'pre-state: codex hook copy must exist');
      assert.ok(existsSync(codexCmd), 'pre-state: codex command copy must exist');

      // Claude-only uninstall — MUST leave Codex state intact.
      const un = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(un.status, 0, `claude-only uninstall failed: ${un.stderr}\n${un.stdout}`);

      // Claude target stripped.
      assert.ok(
        !existsSync(join(home, '.claude', 'hooks', 'hypo-ext-cdxonly.mjs')),
        'claude hook copy must be removed',
      );

      // Codex hard-copies survive the claude-only uninstall.
      assert.ok(existsSync(codexHook), 'codex hook copy must survive claude-only uninstall');
      assert.ok(existsSync(codexCmd), 'codex command copy must survive claude-only uninstall');

      // pkg.json must NOT be wholesale-deleted — codex baseline must remain.
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      assert.ok(
        existsSync(pkgPath),
        'pkg.json must be preserved while extensions.codex still tracks live copies',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.ok(
        pkg.extensions?.codex?.['hooks/hypo-ext-cdxonly.mjs'],
        'codex hook SHA baseline must survive (per-target contract D2b)',
      );
      assert.ok(
        pkg.extensions?.codex?.['commands/hypo-ext-cdxcmd.md'],
        'codex command SHA baseline must survive',
      );
      // Claude target either dropped or cleared.
      const claudeMap = pkg.extensions?.claude;
      assert.ok(
        claudeMap === undefined || Object.keys(claudeMap).length === 0,
        'claude per-target map must be cleared by the uninstall',
      );
    });
  });
});

// Plan §5 #6 (boost #6): non-regular destinations (symlink/socket/etc.) are
// always preserved — `--force-extensions` does NOT follow them. Mirrors the
// install/upgrade E3 guard so uninstall cannot delete a foreign target via a
// dangling symlink in ~/.claude/hooks/.
test('uninstall-extensions-skips-non-regular-symlink', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      writeExt(hypoDir, 'hooks', 'hypo-ext-symwatch.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      const up = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(up.status, 0, `upgrade failed: ${up.stderr}`);

      // Replace the regular hard-copy with a symlink to a decoy.
      const target = join(home, '.claude', 'hooks', 'hypo-ext-symwatch.mjs');
      const decoy = join(dir, 'decoy.mjs');
      writeFileSync(decoy, '// decoy — must remain untouched\n');
      rmSync(target);
      symlinkSync(decoy, target);

      // Without force → skip + report.
      const un1 = runWithHome('uninstall.mjs', ['--apply'], home);
      assert.equal(un1.status, 0, `uninstall failed: ${un1.stderr}\n${un1.stdout}`);
      assert.ok(existsSync(target), 'symlink must not be removed without force');
      assert.ok(existsSync(decoy), 'decoy target of symlink must remain untouched');
      assert.ok(
        un1.stdout.includes('non-regular'),
        `report must mention non-regular skip: ${un1.stdout}`,
      );

      // --force-extensions must STILL refuse to follow non-regular destinations.
      const un2 = runWithHome('uninstall.mjs', ['--apply', '--force-extensions'], home);
      assert.equal(un2.status, 0, `force uninstall failed: ${un2.stderr}\n${un2.stdout}`);
      assert.ok(existsSync(target), '--force-extensions must NOT follow symlinks');
      assert.ok(existsSync(decoy), 'decoy must remain untouched under --force-extensions');
    });
  });
});
