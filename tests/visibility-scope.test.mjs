// tests/visibility-scope.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateColdCandidates } from '../scripts/lib/page-usage.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  SCRIPTS,
  SESSION_TMP_HOME,
  currentDevice,
  markerPath,
  readVisibilityScope,
  run,
  runFirstPrompt,
  runHook,
  scopeVisible,
  withGrowthWiki,
  withTmpDir,
  writeMarker,
} from './helpers.mjs';

// ── visibility scope: currentDevice / predicate / reader ─────────────────────

suite('scope: currentDevice source');

test('currentDevice reads HYPO_DEVICE override', () => {
  const prev = process.env.HYPO_DEVICE;
  try {
    process.env.HYPO_DEVICE = 'dev-a';
    assert.equal(currentDevice(), 'dev-a');
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
});

test('currentDevice strips CR/LF from the device token', () => {
  const prev = process.env.HYPO_DEVICE;
  try {
    process.env.HYPO_DEVICE = 'x\ny';
    assert.equal(currentDevice(), 'xy');
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
});

test('currentDevice falls back to a non-empty string without HYPO_DEVICE', () => {
  const prev = process.env.HYPO_DEVICE;
  try {
    delete process.env.HYPO_DEVICE;
    const d = currentDevice();
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 0, 'fallback device is non-empty');
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
});

test('currentDevice: a CR/LF-only HYPO_DEVICE collapses to fallback, never empty', () => {
  const prev = process.env.HYPO_DEVICE;
  try {
    // A truthy-but-whitespace value must NOT yield '' (which would make
    // scopeVisible('machine:', device) pass and unhide the empty-owner page).
    process.env.HYPO_DEVICE = '\r\n';
    const d = currentDevice();
    assert.ok(
      d.length > 0,
      `CR/LF-only device must fall back to non-empty, got ${JSON.stringify(d)}`,
    );
    assert.equal(
      scopeVisible('machine:', d),
      false,
      'empty-owner machine: must stay hidden under the fallback device',
    );
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
});

suite('scope: scopeVisible predicate');

test('scopeVisible: no field and shared are visible', () => {
  assert.equal(scopeVisible('', 'a'), true);
  assert.equal(scopeVisible('shared', 'a'), true);
});

test('scopeVisible: machine matches only the owning device', () => {
  assert.equal(scopeVisible('machine:a', 'a'), true);
  assert.equal(scopeVisible('machine:b', 'a'), false);
});

test('scopeVisible: agent prefix is reserved and passes (forward-compat)', () => {
  assert.equal(scopeVisible('agent:x', 'a'), true);
});

test('scopeVisible: empty owner (machine:) hides everywhere', () => {
  assert.equal(scopeVisible('machine:', 'a'), false);
});

suite('scope: readVisibilityScope reader');

test('readVisibilityScope strips an inline YAML comment', () => {
  assert.equal(readVisibilityScope('---\nvisibility_scope: machine:a # note\n---\n'), 'machine:a');
});

test('readVisibilityScope is first-wins on a repeated key', () => {
  assert.equal(
    readVisibilityScope('---\nvisibility_scope: machine:a\nvisibility_scope: machine:b\n---\n'),
    'machine:a',
  );
});

test('readVisibilityScope returns empty when the field is absent', () => {
  assert.equal(readVisibilityScope('---\ntype: note\n---\nbody'), '');
  assert.equal(readVisibilityScope('no frontmatter at all'), '');
});

// ── T4: hypo-lookup.mjs visibility_scope filtering ───────────────────────────
suite('hypo-lookup.mjs — visibility_scope filtering (T4)');

function visibilityScopeVaultT4(dir) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  // machine:devA page — must be invisible on devB, visible on devA.
  writeFileSync(
    join(dir, 'pages', 'devA-secret.md'),
    '---\ntype: page\ntitle: DevA Secret\nvisibility_scope: machine:devA\n---\n' +
      '# body about gizmo frobnication\n',
  );
  // fieldless page — must always pass through unfiltered (golden invariant).
  writeFileSync(
    join(dir, 'pages', 'plain-notes.md'),
    '---\ntype: page\ntitle: Plain Notes\n---\n# body about gizmo frobnication\n',
  );
  writeFileSync(
    join(dir, 'index.md'),
    [
      '# Index',
      '- [[devA-secret]] — gizmo frobnication machine-only notes',
      '- [[plain-notes]] — gizmo frobnication general notes',
    ].join('\n'),
  );
}

// A prompt matching ONLY the machine-scoped page (never the fieldless one), so
// that on a non-owning device `matched` is non-empty but `visibleMatched` is
// empty. Because the miss decision is made on visibleMatched, this must take the
// clean miss path (closest = none, since the only match is hidden) — NOT the
// misleading "index hit but files missing" branch — and of course leak no slug.
function machineOnlyVaultT4(dir) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(
    join(dir, 'pages', 'devA-only.md'),
    '---\ntype: page\ntitle: DevA Only\nvisibility_scope: machine:devA\n---\n' +
      '# body about quibbleflux widgetry\n',
  );
  writeFileSync(
    join(dir, 'index.md'),
    ['# Index', '- [[devA-only]] — quibbleflux widgetry machine-only notes'].join('\n'),
  );
}

test('non-owning device: machine-scoped slug excluded from injection, fieldless slug still injected', () => {
  withTmpDir((dir) => {
    visibilityScopeVaultT4(dir);
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'gizmo frobnication' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(!ctx.includes('devA-secret'), `machine:devA slug must not leak on devB: ${ctx}`);
    assert.ok(ctx.includes('plain-notes'), `fieldless page must still be injected: ${ctx}`);
  });
});

test('owning device: machine-scoped slug is injected', () => {
  withTmpDir((dir) => {
    visibilityScopeVaultT4(dir);
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'gizmo frobnication' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(ctx.includes('devA-secret'), `machine:devA slug must be injected on devA: ${ctx}`);
  });
});

test('non-owning device whose only match is machine-scoped: clean miss, no leak, no "files missing"', () => {
  withTmpDir((dir) => {
    machineOnlyVaultT4(dir);
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'quibbleflux widgetry' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(!ctx.includes('devA-only'), `machine:devA slug must not leak: ${ctx}`);
    assert.ok(
      !ctx.includes('files missing'),
      `a hidden-only match must not report "files missing": ${ctx}`,
    );
    assert.ok(
      ctx.includes('LOOKUP: miss'),
      `a hidden-only match must take the clean miss path: ${ctx}`,
    );
  });
});

test('owning device whose only match is machine-scoped: page is injected', () => {
  withTmpDir((dir) => {
    machineOnlyVaultT4(dir);
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'quibbleflux widgetry' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    const ctx = JSON.parse(r.stdout).additionalContext ?? '';
    assert.ok(ctx.includes('devA-only'), `machine:devA page must inject on devA: ${ctx}`);
  });
});

test('miss path survives an unstat-able entry in the page tree (buildPageMap skips it)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'index.md'), '# Index\n- [[real-note]] — apple banana cherry\n');
    writeFileSync(
      join(dir, 'pages', 'real-note.md'),
      '---\ntype: page\ntitle: Real\n---\n# apple banana cherry\n',
    );
    // A dangling symlink makes statSync throw. Because the page tree is now
    // scanned BEFORE the miss branch, an unguarded throw would sink the whole
    // lookup into the silent outer catch instead of the clean miss message.
    symlinkSync(join(dir, 'pages', 'nonexistent-target.md'), join(dir, 'pages', 'dangling.md'));
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'zzqqxx nomatch' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    const ctx = JSON.parse(r.stdout).additionalContext ?? '';
    assert.ok(
      ctx.includes('LOOKUP: miss'),
      `a dangling symlink must not suppress the clean miss message: ${JSON.stringify(ctx)}`,
    );
  });
});

// ── query.mjs — visibility_scope filtering ──────────────────────────────────
// query.mjs must gate results through readVisibilityScope(raw) + scopeVisible()
// (the shared frontmatter reader, not a local last-wins parser) so a
// `machine:<owner>` page only surfaces on its own machine, an inline-comment
// value (`machine:devA # note`) still matches on devA, and a page with no
// visibility_scope field is unaffected on every machine.

suite('query.mjs — visibility_scope filtering');

test('visibility_scope: machine-scoped page hidden on a different device, visible on its own', () => {
  withTmpDir((dirT5) => {
    mkdirSync(join(dirT5, 'pages'), { recursive: true });
    writeFileSync(
      join(dirT5, 'pages', 'machine-a-t5.md'),
      '---\ntitle: machine a\ntype: note\nvisibility_scope: machine:devA # note\n---\nscopewordT5 machine-only body\n',
    );
    writeFileSync(
      join(dirT5, 'pages', 'no-scope-t5.md'),
      '---\ntitle: no scope\ntype: note\n---\nscopewordT5 unscoped body\n',
    );

    const origDevice = process.env.HYPO_DEVICE;
    try {
      process.env.HYPO_DEVICE = 'devB';
      const rOther = run('query.mjs', [`--hypo-dir=${dirT5}`, '--q=scopewordT5', '--json']);
      assert.equal(rOther.status, 0, `should exit 0: ${rOther.stderr}`);
      const slugsOther = JSON.parse(rOther.stdout).map((r) => r.slug);
      assert.ok(
        !slugsOther.includes('pages/machine-a-t5'),
        `machine:devA page must be hidden on devB: ${rOther.stdout}`,
      );
      assert.ok(
        slugsOther.includes('pages/no-scope-t5'),
        `unscoped page must remain visible on devB: ${rOther.stdout}`,
      );

      process.env.HYPO_DEVICE = 'devA';
      const rOwn = run('query.mjs', [`--hypo-dir=${dirT5}`, '--q=scopewordT5', '--json']);
      assert.equal(rOwn.status, 0, `should exit 0: ${rOwn.stderr}`);
      const slugsOwn = JSON.parse(rOwn.stdout).map((r) => r.slug);
      assert.ok(
        slugsOwn.includes('pages/machine-a-t5'),
        `inline-comment machine:devA page must match on devA (readVisibilityScope path): ${rOwn.stdout}`,
      );
      assert.ok(
        slugsOwn.includes('pages/no-scope-t5'),
        `unscoped page must remain visible on devA: ${rOwn.stdout}`,
      );
    } finally {
      if (origDevice === undefined) delete process.env.HYPO_DEVICE;
      else process.env.HYPO_DEVICE = origDevice;
    }
  });
});

suite('hypo-file-watch: visibility scope gate');

test('hypo-file-watch: machine-scoped page is not injected on a non-owning device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-fw-'));
  try {
    const filePath = join(dir, 'hot.md');
    writeFileSync(filePath, '---\nvisibility_scope: machine:devA\n---\n\n# hot\n\nbody text\n');
    const r = runHook(
      'hypo-file-watch.mjs',
      { file_path: filePath },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.ok(!('additionalContext' in out), 'scoped page must not inject on a foreign device');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hypo-file-watch: machine-scoped page is injected on its owning device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-fw-'));
  try {
    const filePath = join(dir, 'hot.md');
    writeFileSync(filePath, '---\nvisibility_scope: machine:devA\n---\n\n# hot\n\nbody text\n');
    const r = runHook(
      'hypo-file-watch.mjs',
      { file_path: filePath },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.ok('additionalContext' in out, 'owning device must still get the injection');
    assert.ok(out.additionalContext.includes('body text'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hypo-file-watch: a page with no visibility_scope field injects regardless of device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-fw-'));
  try {
    const filePath = join(dir, 'hot.md');
    writeFileSync(filePath, '# hot\n\nno scope field here\n');

    const r1 = runHook(
      'hypo-file-watch.mjs',
      { file_path: filePath },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    const out1 = JSON.parse(r1.stdout);
    assert.ok('additionalContext' in out1, 'unscoped page must inject on any device (devB)');

    const r2 = runHook(
      'hypo-file-watch.mjs',
      { file_path: filePath },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    const out2 = JSON.parse(r2.stdout);
    assert.ok('additionalContext' in out2, 'unscoped page must inject on any device (devA)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

suite('page-usage.mjs — visibility scope filtering of cold candidates (T7)');

test('aggregateColdCandidates excludes a machine-scoped page for a non-owning device, includes it for the owner', () => {
  withTmpDir((dir) => {
    const nowT7 = Date.parse('2026-07-04T00:00:00Z');
    const dayT7 = 86400000;
    mkdirSync(join(dir, 'pages'), { recursive: true });
    // Shared page carries the only inbound link to the machine-scoped page.
    writeFileSync(
      join(dir, 'pages', 'hub.md'),
      '---\ntype: page\ntitle: Hub\n---\n# Hub\n[[machine-page]]\n',
    );
    writeFileSync(
      join(dir, 'pages', 'machine-page.md'),
      '---\ntype: page\ntitle: Machine Page\nvisibility_scope: machine:devA\n---\n# Machine Page\n',
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'page-usage.jsonl'),
      [
        JSON.stringify({ ts: new Date(nowT7 - 20 * dayT7).toISOString(), slug: 'anchor' }),
        JSON.stringify({ ts: new Date(nowT7 - 1 * dayT7).toISOString(), slug: 'anchor2' }),
      ].join('\n') + '\n',
    );

    const asDevB = aggregateColdCandidates(dir, { now: nowT7, device: 'devB' });
    assert.equal(asDevB.status, 'ok');
    assert.ok(
      !asDevB.candidates.some((c) => c.slug === 'pages/machine-page'),
      `machine:devA page must be excluded for devB: ${JSON.stringify(asDevB.candidates)}`,
    );

    const asDevA = aggregateColdCandidates(dir, { now: nowT7, device: 'devA' });
    assert.equal(asDevA.status, 'ok');
    assert.ok(
      asDevA.candidates.some((c) => c.slug === 'pages/machine-page'),
      `machine:devA page must be a normal cold candidate on its own device: ${JSON.stringify(asDevA.candidates)}`,
    );
  });
});

test('graph invariant: a shared page whose sole inbound link comes from a machine-scoped page has identical cold candidacy across devices', () => {
  withTmpDir((dir) => {
    const nowT7 = Date.parse('2026-07-04T00:00:00Z');
    const dayT7 = 86400000;
    mkdirSync(join(dir, 'pages'), { recursive: true });
    // machine-source is visible only on devA, but its outbound link must still
    // count toward shared-target's inbound-link graph on EVERY device — the
    // scope filter applies only at the final candidate step, never at graph
    // construction (formOwners / hasInbound).
    writeFileSync(
      join(dir, 'pages', 'machine-source.md'),
      '---\ntype: page\ntitle: Machine Source\nvisibility_scope: machine:devA\n---\n# Machine Source\n[[shared-target]]\n',
    );
    writeFileSync(
      join(dir, 'pages', 'shared-target.md'),
      '---\ntype: page\ntitle: Shared Target\n---\n# Shared Target\n',
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'page-usage.jsonl'),
      [
        JSON.stringify({ ts: new Date(nowT7 - 20 * dayT7).toISOString(), slug: 'anchor' }),
        JSON.stringify({ ts: new Date(nowT7 - 1 * dayT7).toISOString(), slug: 'anchor2' }),
      ].join('\n') + '\n',
    );

    const asDevA = aggregateColdCandidates(dir, { now: nowT7, device: 'devA' });
    const asDevB = aggregateColdCandidates(dir, { now: nowT7, device: 'devB' });
    assert.equal(asDevA.status, 'ok');
    assert.equal(asDevB.status, 'ok');
    const inA = asDevA.candidates.some((c) => c.slug === 'pages/shared-target');
    const inB = asDevB.candidates.some((c) => c.slug === 'pages/shared-target');
    assert.ok(
      inA,
      `shared-target must be a cold candidate on devA: ${JSON.stringify(asDevA.candidates)}`,
    );
    assert.equal(
      inA,
      inB,
      `shared-target's cold candidacy must not depend on device (graph invariant): devA=${inA} devB=${inB}`,
    );
  });
});

suite('crystallize.mjs — visibility_scope filters candidate scan (T8)');

test('unlinked candidates respect visibility_scope: machine-scoped pages stay off other devices, fieldless pages stay visible', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'machine-a-page.md'),
      '---\ntype: page\ntitle: Machine A Page\nvisibility_scope: machine:devA\n---\n# Machine A Page\nNo links here.\n',
    );
    writeFileSync(
      join(dir, 'pages', 'shared-page.md'),
      '---\ntype: page\ntitle: Shared Page\n---\n# Shared Page\nNo links here either.\n',
    );

    const prevDevice = process.env.HYPO_DEVICE;
    try {
      process.env.HYPO_DEVICE = 'devB';
      const rOther = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']);
      assert.equal(rOther.status, 0);
      const slugsOther = JSON.parse(rOther.stdout).unlinked.map((p) => p.slug);
      assert.ok(
        !slugsOther.includes('pages/machine-a-page'),
        `machine:devA page must be hidden on devB: ${rOther.stdout}`,
      );
      assert.ok(
        slugsOther.includes('pages/shared-page'),
        `fieldless page must remain visible: ${rOther.stdout}`,
      );

      process.env.HYPO_DEVICE = 'devA';
      const rOwn = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']);
      assert.equal(rOwn.status, 0);
      const slugsOwn = JSON.parse(rOwn.stdout).unlinked.map((p) => p.slug);
      assert.ok(
        slugsOwn.includes('pages/machine-a-page'),
        `machine:devA page must be visible on devA: ${rOwn.stdout}`,
      );
    } finally {
      if (prevDevice === undefined) delete process.env.HYPO_DEVICE;
      else process.env.HYPO_DEVICE = prevDevice;
    }
  });
});

// ── cross-consumer visibility regression ─────────────────────────────────────
// Ties the five consumers together: (a) a fieldless-only vault is device-
// invariant (golden), (b) one machine:devA page is withheld from a non-owning
// device on every surface, (c) the inline-comment value matches on its own
// machine (readVisibilityScope unification). Kept alongside the per-consumer
// tests on purpose: this suite survives if any single per-task test is later
// changed, so a regression in cross-cutting behavior still trips a gate.

suite('cross-consumer visibility regression');

// Indexed vault: both pages are discoverable by lookup (index.md entries) and
// query (body match on "xyzzy plover"). The machine page carries no outbound
// wikilinks so it is also a crystallize `unlinked` candidate. withMachine off
// yields a fieldless-only vault for the golden check.
function scopeVaultX10(dir, { withMachine = true } = {}) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  if (withMachine) {
    writeFileSync(
      join(dir, 'pages', 'devA-note.md'),
      '---\ntype: page\ntitle: DevA Note\nvisibility_scope: machine:devA\n---\n# xyzzy plover machine-only body\n',
    );
  }
  writeFileSync(
    join(dir, 'pages', 'shared-note.md'),
    '---\ntype: page\ntitle: Shared Note\n---\n# xyzzy plover shared body\n',
  );
  const idx = ['# Index', '- [[shared-note]] — xyzzy plover shared notes'];
  if (withMachine) idx.splice(1, 0, '- [[devA-note]] — xyzzy plover machine notes');
  writeFileSync(join(dir, 'index.md'), idx.join('\n') + '\n');
}

function lookupCtxX10(dir, device) {
  const r = runHook(
    'hypo-lookup.mjs',
    { prompt: 'xyzzy plover' },
    { HYPO_DIR: dir, HYPO_DEVICE: device },
  );
  return JSON.parse(r.stdout).additionalContext ?? '';
}

function withDeviceX10(device, fn) {
  const prev = process.env.HYPO_DEVICE;
  try {
    process.env.HYPO_DEVICE = device;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
}

function querySlugsX10(dir, device, q = 'xyzzy') {
  return withDeviceX10(device, () =>
    JSON.parse(run('query.mjs', [`--hypo-dir=${dir}`, `--q=${q}`, '--json']).stdout).map(
      (x) => x.slug,
    ),
  );
}

test('golden: a fieldless-only vault yields device-invariant lookup + query output', () => {
  withTmpDir((dir) => {
    scopeVaultX10(dir, { withMachine: false });
    assert.equal(
      lookupCtxX10(dir, 'devA'),
      lookupCtxX10(dir, 'devB'),
      'lookup injection must not depend on device when no page is scoped',
    );
    assert.deepEqual(
      querySlugsX10(dir, 'devA').sort(),
      querySlugsX10(dir, 'devB').sort(),
      'query results must not depend on device when no page is scoped',
    );
  });
});

test('injection surfaces (lookup + query + file-watch) withhold machine:devA from devB, keep it for devA', () => {
  withTmpDir((dir) => {
    scopeVaultX10(dir);
    const ctxB = lookupCtxX10(dir, 'devB');
    assert.ok(!ctxB.includes('devA-note'), `lookup must not inject machine:devA on devB: ${ctxB}`);
    assert.ok(ctxB.includes('shared-note'), 'lookup must still inject the fieldless page on devB');
    assert.ok(
      lookupCtxX10(dir, 'devA').includes('devA-note'),
      'lookup must inject machine:devA on devA',
    );
    const qB = querySlugsX10(dir, 'devB');
    assert.ok(!qB.includes('pages/devA-note'), `query must hide machine:devA on devB: ${qB}`);
    assert.ok(qB.includes('pages/shared-note'), 'query must keep the fieldless page on devB');
    assert.ok(
      querySlugsX10(dir, 'devA').includes('pages/devA-note'),
      'query must show machine:devA on devA',
    );
    const fwB = JSON.parse(
      runHook(
        'hypo-file-watch.mjs',
        { file_path: join(dir, 'pages', 'devA-note.md') },
        { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
      ).stdout,
    );
    assert.ok(!('additionalContext' in fwB), 'file-watch must not inject machine:devA on devB');
    const fwA = JSON.parse(
      runHook(
        'hypo-file-watch.mjs',
        { file_path: join(dir, 'pages', 'devA-note.md') },
        { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
      ).stdout,
    );
    assert.ok('additionalContext' in fwA, 'file-watch must inject machine:devA on devA');
  });
});

test('aggregation surfaces (crystallize candidate + cold) withhold machine:devA from devB', () => {
  withTmpDir((dir) => {
    // hub gives the machine page an inbound link (cold candidacy) while the
    // machine page keeps no outbound links (crystallize `unlinked` candidacy).
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'hub.md'),
      '---\ntype: page\ntitle: Hub\n---\n# Hub\n[[machine-page]]\n',
    );
    writeFileSync(
      join(dir, 'pages', 'machine-page.md'),
      '---\ntype: page\ntitle: Machine Page\nvisibility_scope: machine:devA\n---\n# Machine Page body\n',
    );
    const unlinkedB = withDeviceX10('devB', () =>
      JSON.parse(run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']).stdout).unlinked.map(
        (p) => p.slug,
      ),
    );
    assert.ok(
      !unlinkedB.includes('pages/machine-page'),
      `crystallize must not surface machine:devA on devB: ${unlinkedB}`,
    );
    const unlinkedA = withDeviceX10('devA', () =>
      JSON.parse(run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']).stdout).unlinked.map(
        (p) => p.slug,
      ),
    );
    assert.ok(
      unlinkedA.includes('pages/machine-page'),
      `crystallize must surface machine:devA on devA: ${unlinkedA}`,
    );
    const nowX10 = Date.parse('2026-07-04T00:00:00Z');
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'page-usage.jsonl'),
      JSON.stringify({ ts: new Date(nowX10 - 20 * 86400000).toISOString(), slug: 'anchor' }) +
        '\n' +
        JSON.stringify({ ts: new Date(nowX10 - 86400000).toISOString(), slug: 'anchor2' }) +
        '\n',
    );
    const coldB = aggregateColdCandidates(dir, { now: nowX10, device: 'devB' }).candidates.map(
      (c) => c.slug,
    );
    assert.ok(
      !coldB.includes('pages/machine-page'),
      `cold aggregation must exclude machine:devA on devB: ${coldB}`,
    );
    const coldA = aggregateColdCandidates(dir, { now: nowX10, device: 'devA' }).candidates.map(
      (c) => c.slug,
    );
    assert.ok(
      coldA.includes('pages/machine-page'),
      `cold aggregation must include machine:devA on devA: ${coldA}`,
    );
  });
});

test('inline-comment machine:devA # note is honored on its own machine and hidden elsewhere (query)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'commented.md'),
      '---\ntype: page\ntitle: Commented\nvisibility_scope: machine:devA # personal\n---\n# grault garply body\n',
    );
    assert.ok(
      querySlugsX10(dir, 'devA', 'grault').includes('pages/commented'),
      'inline-comment machine:devA must match on devA (readVisibilityScope strips the comment)',
    );
    assert.ok(
      !querySlugsX10(dir, 'devB', 'grault').includes('pages/commented'),
      'inline-comment machine:devA must hide on devB',
    );
  });
});

// ── FEAT-5 T11: visibility_scope on the session-resume paths ─────────────────
// T4-T8 wired the five content-injection consumers. The session-resume paths
// (session-start, cwd-change, resume.mjs) read the SAME projects/<p>/hot.md and
// session-state.md that hypo-file-watch already filters, so leaving them
// unfiltered made one file behave differently depending on which path opened it:
// the user sets visibility_scope, watches file-watch honor it, and never learns
// session start still ships the body. That is a false guarantee, not a fail-open.
suite('FEAT-5 T11 — session-resume paths honor visibility_scope');

// Same shape as withPrivateProject, but hot/state carry a scope line. The body
// markers are exactly what must not reach a foreign device.
function withScopedProject(scopeLine, fn) {
  withGrowthWiki((dir) => {
    const work = mkdtempSync(join(tmpdir(), 'hypo-scope-work-'));
    const projDir = join(dir, 'projects', 'scoped');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      `---\ntitle: scoped\ntype: project-index\nupdated: 2026-07-12\nworking_dir: "${work}"\n---\n# Scoped\n`,
    );
    const fm = scopeLine ? `---\n${scopeLine}\n---\n` : '';
    writeFileSync(join(projDir, 'hot.md'), `${fm}# hot\nSCOPED_HOT_BODY\n`);
    writeFileSync(join(projDir, 'session-state.md'), `${fm}# state\nSCOPED_STATE_BODY\n`);
    try {
      fn(dir, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

const SCOPED_BODIES = /SCOPED_HOT_BODY|SCOPED_STATE_BODY/;

test('session-start hides a machine-scoped project hot/state on a foreign device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'test-t11-ss-foreign' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `machine:devA body leaked into session-start on devB: ${r.stdout}`,
    );
  });
});

test('session-start still injects a machine-scoped project hot/state on its own device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'test-t11-ss-own' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /SCOPED_HOT_BODY/.test(r.stdout) && /SCOPED_STATE_BODY/.test(r.stdout),
      `expected hot+state injection on the owning device: ${r.stdout}`,
    );
  });
});

test('session-start leaves an unscoped project unchanged on every device', () => {
  for (const device of ['devA', 'devB']) {
    withScopedProject('', (dir, work) => {
      const r = runHook(
        'hypo-session-start.mjs',
        { cwd: work, session_id: `test-t11-ss-plain-${device}` },
        { HYPO_DIR: dir, HYPO_DEVICE: device },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        /SCOPED_HOT_BODY/.test(r.stdout) && /SCOPED_STATE_BODY/.test(r.stdout),
        `a field-less project must inject on ${device}: ${r.stdout}`,
      );
    });
  }
});

test('cwd-change hides a machine-scoped project hot on a foreign device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-cwd-change.mjs',
      { new_cwd: work, old_cwd: '/tmp', session_id: 'test-t11-cwd-foreign' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `machine:devA hot leaked into cwd-change on devB: ${r.stdout}`,
    );
  });
});

test('cwd-change still injects a machine-scoped project hot on its own device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-cwd-change.mjs',
      { new_cwd: work, old_cwd: '/tmp', session_id: 'test-t11-cwd-own' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devA' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /SCOPED_HOT_BODY/.test(r.stdout),
      `expected hot injection on the owning device: ${r.stdout}`,
    );
  });
});

test('resume.mjs hides a machine-scoped session-state on a foreign device and says why', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, '--project=scoped'],
      {
        cwd: work,
        encoding: 'utf-8',
        env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DEVICE: 'devB' },
      },
    );
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `machine:devA body leaked through resume stdout on devB: ${r.stdout}`,
    );
    // A scoped-out state file is not a missing one. Reporting "no session-state.md
    // found" would read as a broken vault, so the reason must be explicit.
    assert.ok(
      /scoped to another machine/.test(r.stderr),
      `expected an explicit scoped-out reason, got: ${r.stderr}`,
    );
  });
});

test('resume.mjs still returns a machine-scoped session-state on its own device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, '--project=scoped'],
      {
        cwd: work,
        encoding: 'utf-8',
        env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DEVICE: 'devA' },
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /SCOPED_STATE_BODY/.test(r.stdout) && /SCOPED_HOT_BODY/.test(r.stdout),
      `expected state+hot on the owning device: ${r.stdout}`,
    );
  });
});

// --json serializes the bodies through a different branch than the text output,
// so it needs its own foreign-device assertion.
test('resume.mjs --json does not serialize a machine-scoped body on a foreign device', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, '--project=scoped', '--json'],
      {
        cwd: work,
        encoding: 'utf-8',
        env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DEVICE: 'devB' },
      },
    );
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `machine:devA body leaked through the --json branch on devB: ${r.stdout}`,
    );
  });
});

// The two files are scoped independently, so a visible state must still come
// through when only hot.md is scoped out (and hot's body must not).
test('resume.mjs returns a visible session-state while hiding a scoped-out hot.md', () => {
  withScopedProject('', (dir, work) => {
    writeFileSync(
      join(dir, 'projects', 'scoped', 'hot.md'),
      '---\nvisibility_scope: machine:devA\n---\n# hot\nSCOPED_HOT_BODY\n',
    );
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, '--project=scoped'],
      {
        cwd: work,
        encoding: 'utf-8',
        env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DEVICE: 'devB' },
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /SCOPED_STATE_BODY/.test(r.stdout),
      `the unscoped session-state must still surface: ${r.stdout}`,
    );
    assert.ok(
      !/SCOPED_HOT_BODY/.test(r.stdout),
      `the scoped-out hot body must not surface: ${r.stdout}`,
    );
  });
});

// Scoped-out must not be reported as absent. "no snapshot yet" would make the
// model treat a resumed project as a first session. The fix says which it is,
// while naming nothing from the withheld body.
test('session-start reports a scoped-out snapshot as scoped, not as "no snapshot yet"', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'test-t11-ss-reason' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /scoped to another machine/.test(r.stdout),
      `expected the scoped-out reason in additionalContext: ${r.stdout}`,
    );
    assert.ok(
      !/no snapshot yet/.test(r.stdout),
      `a scoped-out snapshot must not be reported as absent: ${r.stdout}`,
    );
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `the explanation must not re-leak the body: ${r.stdout}`,
    );
  });
});

test('cwd-change reports a scoped-out hot as scoped, not as "will be created"', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const r = runHook(
      'hypo-cwd-change.mjs',
      { new_cwd: work, old_cwd: '/tmp', session_id: 'test-t11-cwd-reason' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /scoped to another machine/.test(r.stdout),
      `expected the scoped-out placeholder: ${r.stdout}`,
    );
    assert.ok(
      !/will be created at session close/.test(r.stdout),
      `an existing scoped hot.md must not be advertised as creatable: ${r.stdout}`,
    );
    assert.ok(
      !SCOPED_BODIES.test(r.stdout),
      `the placeholder must not re-leak the body: ${r.stdout}`,
    );
  });
});

// The lie also travels through the marker: hypo-first-prompt builds its resume
// line from the marker alone, so fixing only session-start's own output would
// still let the NEXT prompt announce "first session" for a project that merely
// lives on another machine. That is the announcement that invites the model to
// author a fresh hot.md over the owning machine's copy.
test('first-prompt does not call a scoped-out project a first session', () => {
  const sid = `fp-scoped-${process.pid}-${Date.now()}`;
  writeMarker(sid, { proj: 'demo', hotPath: null, scopedOut: true });
  try {
    const r = runFirstPrompt(sid);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout).additionalContext || '';
    assert.match(out, /scoped to another machine/, 'must name the scope as the reason');
    assert.doesNotMatch(out, /first session/, 'a scoped-out project is not a first session');
  } finally {
    if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
  }
});

test('first-prompt still calls a genuinely snapshot-less project a first session', () => {
  const sid = `fp-absent-${process.pid}-${Date.now()}`;
  writeMarker(sid, { proj: 'demo', hotPath: null });
  try {
    const r = runFirstPrompt(sid);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout).additionalContext || '';
    assert.match(
      out,
      /first session/,
      'a genuinely absent snapshot must still read as first session',
    );
    assert.doesNotMatch(out, /scoped to another machine/, 'must not claim a scope that is not set');
  } finally {
    if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
  }
});

// The two files are scoped independently. When hot is hidden but state is shared,
// session-start must take the CONTENT branch: inject the state, withhold the hot
// body, and report hasSnapshot truthfully (a snapshot really was injected). The
// marker then carries a hotPath pointing at a hidden file, so nothing downstream
// may read that path for content. first-prompt only existsSync's it.
test('session-start injects a shared state while withholding a scoped-out hot, and stays truthful', () => {
  withScopedProject('', (dir, work) => {
    writeFileSync(
      join(dir, 'projects', 'scoped', 'hot.md'),
      '---\nvisibility_scope: machine:devA\n---\n# hot\nSCOPED_HOT_BODY\n',
    );
    const sid = `t11-mixed-${process.pid}-${Date.now()}`;
    try {
      const r = runHook(
        'hypo-session-start.mjs',
        { cwd: work, session_id: sid },
        { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        !/SCOPED_HOT_BODY/.test(r.stdout),
        `the hidden hot body must not surface: ${r.stdout}`,
      );
      assert.ok(
        /SCOPED_STATE_BODY/.test(r.stdout),
        `the shared state must still surface: ${r.stdout}`,
      );

      // hasSnapshot: true is the honest answer here, a snapshot WAS injected.
      const marker = JSON.parse(readFileSync(markerPath(sid), 'utf-8'));
      assert.equal(marker.hasSnapshot, true, 'a partially visible snapshot is still a snapshot');

      const fp = runFirstPrompt(sid);
      const out = JSON.parse(fp.stdout).additionalContext || '';
      assert.ok(
        !/SCOPED_HOT_BODY/.test(out),
        `first-prompt must not read the hidden hotPath for content: ${out}`,
      );
    } finally {
      if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
    }
  });
});

// cwd-change deliberately arms the first-prompt marker only when real content was
// injected (a forced "Resuming" line with nothing to summarize is empty noise).
// A scoped-out hot takes that same path, which is correct precisely because the
// additionalContext placeholder already states the fact: the model is not left
// silent, it is told the snapshot lives elsewhere.
test('cwd-change does not arm the resume marker for a scoped-out hot', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const sid = `t11-cc-marker-${process.pid}-${Date.now()}`;
    try {
      const r = runHook(
        'hypo-cwd-change.mjs',
        { new_cwd: work, old_cwd: '/tmp', session_id: sid },
        { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        /scoped to another machine/.test(r.stdout),
        `the placeholder must state the fact: ${r.stdout}`,
      );
      assert.ok(
        !existsSync(markerPath(sid)),
        'no forced resume line when there is nothing visible to summarize',
      );
    } finally {
      if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
    }
  });
});

// End to end: the marker session-start actually writes must carry the fact.
test('session-start stamps scopedOut on the marker it hands to first-prompt', () => {
  withScopedProject('visibility_scope: machine:devA', (dir, work) => {
    const sid = `t11-e2e-${process.pid}-${Date.now()}`;
    try {
      const r = runHook(
        'hypo-session-start.mjs',
        { cwd: work, session_id: sid },
        { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const marker = JSON.parse(readFileSync(markerPath(sid), 'utf-8'));
      assert.equal(
        marker.scopedOut,
        true,
        `marker must record the scope hide: ${JSON.stringify(marker)}`,
      );

      const fp = runFirstPrompt(sid);
      const out = JSON.parse(fp.stdout).additionalContext || '';
      assert.doesNotMatch(
        out,
        /first session/,
        'the hand-off must not degrade into "first session"',
      );
      assert.ok(!SCOPED_BODIES.test(out), `first-prompt must not surface the body either: ${out}`);
    } finally {
      if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
    }
  });
});

// The scoped-out branch must not swallow the genuine first-session signal.
test('session-start still says "no snapshot yet" when the files are genuinely absent', () => {
  withScopedProject('', (dir, work) => {
    rmSync(join(dir, 'projects', 'scoped', 'hot.md'));
    rmSync(join(dir, 'projects', 'scoped', 'session-state.md'));
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'test-t11-ss-absent' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'devB' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      /no snapshot yet/.test(r.stdout),
      `a genuinely absent snapshot must still read as absent: ${r.stdout}`,
    );
  });
});
