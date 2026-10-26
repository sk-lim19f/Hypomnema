// tests/test-infra.test.mjs
//
// Tests for the test infrastructure itself: the shared fixtures in helpers.mjs
// and (later) tests/parallel.mjs. One area, one file, one selection unit per suite.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test, suite } from './harness.mjs';
import {
  HOOKS,
  REPO,
  SESSION_TMP_HOME,
  hookWriteFaultPreload,
  settingsWriteFaultPreload,
  withTmpDir,
  withWiki,
} from './helpers.mjs';

suite('test infrastructure: cleanup retries and the settings write-fault fixture');

// Every child gets HOME and HYPO_DIR pinned to temp dirs, and no inherited
// CLAUDE_CONFIG_DIR, so nothing it does can reach the developer's real files.
function childEnv(dir, extra = {}) {
  const env = { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.HYPO_TEST_FAULT_CALLER;
  delete env.HYPO_TEST_HOOK_FAULT;
  return { ...env, ...extra };
}

function runNode(dir, preloadPath, script, args = [], extra = {}) {
  return spawnSync(process.execPath, ['-r', preloadPath, script, ...args], {
    encoding: 'utf-8',
    env: childEnv(dir, extra),
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('withWiki cleanup survives a late writer in .git/objects/pack', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hypo-late-writer-'));
  const ready = join(scratch, 'ready');
  const script = join(scratch, 'late-writer.mjs');
  // Writes fresh files as fast as it can for 500ms and stops on the first failure
  // (ENOENT once the directory is gone). It never recreates the directory. A
  // pause between writes lets one rmdir win the race every time on a fast disk,
  // and the test then stays green with the retry turned off.
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
const [pack, ready] = process.argv.slice(2);
const end = Date.now() + 500;
let n = 0;
try {
  while (Date.now() < end) {
    writeFileSync(pack + '/late-' + n++, 'x');
    if (n === 1) writeFileSync(ready, 'up');
  }
} catch {}
`,
  );
  let wikiDir;
  try {
    withWiki(null, (dir) => {
      wikiDir = dir;
      const child = spawn(process.execPath, [script, join(dir, '.git', 'objects', 'pack'), ready], {
        detached: true,
        stdio: 'ignore',
        env: childEnv(scratch),
      });
      child.unref();
      for (let i = 0; i < 200 && !existsSync(ready); i++) sleepSync(10);
      assert.ok(existsSync(ready), 'the late writer never started');
    });
    assert.ok(wikiDir && !existsSync(wikiDir), 'withWiki left its directory behind');
  } finally {
    // The child may still be exiting; its only target is the wiki dir, which is gone.
    sleepSync(600);
    spawnSync('rm', ['-rf', scratch]);
  }
});

// The race test above shows the cleanup survives one late writer; it cannot show that ENOTEMPTY
// happened, so a cleanup without retries could pass it on a quiet disk. This one makes the first
// removal of each helper's directory fail the way Node 18 to 22 do when a late writer outlasts
// their rmdir-only retries (ENOTEMPTY, directory untouched) and checks the helper removes it anyway.
// Disabling the check: in helpers.mjs rmTree make `attempt >= 5` `attempt >= 1`.
test('the fixture cleanups remove their directory again after an ENOTEMPTY removal', () => {
  const nodeFs = createRequire(import.meta.url)('node:fs');
  const { rmSync } = nodeFs;
  const calls = [];
  nodeFs.rmSync = (path, options) => {
    calls.push({ path, options });
    if (calls.filter((c) => c.path === path).length === 1) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), {
        code: 'ENOTEMPTY',
      });
    }
    return rmSync(path, options);
  };
  syncBuiltinESMExports();
  const dirs = [];
  try {
    withTmpDir((dir) => dirs.push(dir));
    withWiki(null, (dir) => dirs.push(dir));
  } finally {
    nodeFs.rmSync = rmSync;
    syncBuiltinESMExports();
  }
  assert.equal(dirs.length, 2);
  for (const dir of dirs) {
    const mine = calls.filter((c) => c.path === dir);
    assert.ok(mine.length >= 2, `${dir}: the helper did not try again after ENOTEMPTY`);
    const call = mine[mine.length - 1];
    assert.equal(call.options.recursive, true, dir);
    assert.ok(call.options.maxRetries >= 3, `${dir}: ${JSON.stringify(call.options)}`);
    assert.ok(call.options.retryDelay > 0, `${dir}: ${JSON.stringify(call.options)}`);
    assert.equal(existsSync(dir), false, `${dir}: still there`);
  }
});

const ORIGINAL = '{"original":true}\n';
const NEW_TEXT = `{"next":"${'n'.repeat(4000)}"}\n`;

function settingsFixture(dir) {
  const { preloadPath, firedPath } = settingsWriteFaultPreload(dir);
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg);
  const target = join(cfg, 'settings.json');
  writeFileSync(target, ORIGINAL);
  return { preloadPath, firedPath, cfg, target };
}

function rawWriterScript(dir, target) {
  const script = join(dir, 'writer.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
function rawWriter() {
  writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(NEW_TEXT)});
}
rawWriter();
`,
  );
  return script;
}

test('settingsWriteFaultPreload tears a raw writeFileSync of settings.json', () => {
  withTmpDir((dir) => {
    const { preloadPath, firedPath, target } = settingsFixture(dir);
    const script = rawWriterScript(dir, target);
    const r = runNode(dir, preloadPath, script, [], { HYPO_TEST_FAULT_CALLER: 'rawWriter' });
    assert.notEqual(r.status, 0, 'the injected EIO should kill the writer');
    assert.ok(existsSync(firedPath), 'the preload never fired');
    assert.ok(
      readFileSync(firedPath, 'utf-8').includes('writer.mjs'),
      'stack should name the writer',
    );
    const after = readFileSync(target, 'utf-8');
    assert.notEqual(after, ORIGINAL);
    assert.ok(after.length > 0 && after.length < NEW_TEXT.length, `torn length ${after.length}`);
    assert.ok(NEW_TEXT.startsWith(after), 'the torn bytes should be a prefix of the new text');
  });
});

test('settingsWriteFaultPreload stays silent when the armed caller is not on the stack', () => {
  const armings = [{ HYPO_TEST_FAULT_CALLER: 'someOtherWriter' }, {}];
  for (const extra of armings) {
    withTmpDir((dir) => {
      const { preloadPath, firedPath, target } = settingsFixture(dir);
      const script = rawWriterScript(dir, target);
      const r = runNode(dir, preloadPath, script, [], extra);
      assert.equal(r.status, 0, `${JSON.stringify(extra)}: ${r.stderr}`);
      assert.ok(!existsSync(firedPath), `${JSON.stringify(extra)}: fired unexpectedly`);
      assert.equal(readFileSync(target, 'utf-8'), NEW_TEXT);
    });
  }
});

test('settingsWriteFaultPreload leaves settings.json whole under atomicWrite', () => {
  withTmpDir((dir) => {
    const { preloadPath, firedPath, cfg, target } = settingsFixture(dir);
    const script = join(dir, 'atomic.mjs');
    writeFileSync(
      script,
      `import { atomicWrite } from ${JSON.stringify(pathToFileURL(join(HOOKS, 'atomic-write.mjs')).href)};
atomicWrite(${JSON.stringify(target)}, ${JSON.stringify(NEW_TEXT)});
`,
    );
    const r = runNode(dir, preloadPath, script, [], { HYPO_TEST_FAULT_CALLER: 'atomicWrite' });
    assert.notEqual(r.status, 0, 'the injected EIO should surface from atomicWrite');
    assert.ok(existsSync(firedPath), 'the preload never fired');
    assert.equal(readFileSync(target, 'utf-8'), ORIGINAL);
    assert.deepEqual(readdirSync(cfg), ['settings.json'], 'a temp file leaked');
  });
});

test('hookWriteFaultPreload tears a direct pre-commit write and fails a rename onto pre-commit', () => {
  const script = (dir) => {
    const p = join(dir, 'hook-writer.mjs');
    writeFileSync(
      p,
      `import { renameSync, writeFileSync } from 'node:fs';
const [action, hook] = process.argv.slice(2);
if (action === 'write') writeFileSync(hook, ${JSON.stringify(NEW_TEXT)});
if (action === 'bak') writeFileSync(hook + '.bak', ${JSON.stringify(NEW_TEXT)});
if (action === 'rename') {
  writeFileSync(hook + '.next', ${JSON.stringify(NEW_TEXT)});
  renameSync(hook + '.next', hook);
}
`,
    );
    return p;
  };
  // [action, fault mode, fires, expected pre-commit bytes after the run]
  const cases = [
    [
      'write',
      'write',
      true,
      (b) => b !== ORIGINAL && b.length < NEW_TEXT.length && NEW_TEXT.startsWith(b),
    ],
    ['rename', 'rename', true, (b) => b === ORIGINAL],
    ['write', undefined, false, (b) => b === NEW_TEXT],
    ['rename', undefined, false, (b) => b === NEW_TEXT],
    ['bak', 'write', false, (b) => b === ORIGINAL],
  ];
  for (const [action, mode, fires, bytesOk] of cases) {
    withTmpDir((dir) => {
      const { preloadPath, firedPath } = hookWriteFaultPreload(dir);
      const hook = join(dir, 'pre-commit');
      writeFileSync(hook, ORIGINAL);
      const extra = mode ? { HYPO_TEST_HOOK_FAULT: mode } : {};
      const r = runNode(dir, preloadPath, script(dir), [action, hook], extra);
      const label = `${action}/${mode ?? 'unarmed'}`;
      assert.equal(r.status === 0, !fires, `${label}: exit ${r.status} ${r.stderr}`);
      assert.equal(existsSync(firedPath), fires, `${label}: firedPath`);
      if (fires) assert.equal(readFileSync(firedPath, 'utf-8'), hook, `${label}: fired target`);
      assert.ok(bytesOk(readFileSync(hook, 'utf-8')), `${label}: hook bytes`);
    });
  }
});

const PARALLEL = join(REPO, 'tests', 'parallel.mjs');
const REJECTS_JOBS =
  'parallel.mjs rejects --jobs=0 and --jobs=x with exit 2 before spawning anything';

// parallel.mjs inherits HOME on purpose, so the test pins it for the child here.
function runParallel(args) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-parallel-'));
  try {
    return spawnSync(process.execPath, [PARALLEL, ...args], {
      encoding: 'utf-8',
      env: childEnv(dir, { HOME: SESSION_TMP_HOME }),
    });
  } finally {
    spawnSync('rm', ['-rf', dir]);
  }
}

test(REJECTS_JOBS, () => {
  for (const bad of ['--jobs=0', '--jobs=x']) {
    const r = runParallel([bad]);
    assert.equal(r.status, 2, `${bad}: exit ${r.status}`);
    assert.ok(r.stderr.includes('--jobs'), `${bad}: stderr ${r.stderr}`);
    // Validation happens before any shard starts, so no progress line was printed.
    assert.ok(!r.stderr.includes('running'), `${bad}: spawned anyway`);
  }
});

test('parallel.mjs strips --jobs before it reaches the runner', () => {
  // The runner exits 2 on an argument it does not know, so a leaked --jobs fails this run.
  const r = runParallel(['--shards=1', '--jobs=1', `--grep=${REJECTS_JOBS}`]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes('1 passed, 0 failed'), r.stdout);
});

// A copy of the real parallel.mjs beside a stand-in runner and stand-in area files, so the cap is
// observed on the real scheduler without running any real test. Each stand-in child logs its start
// and end, and holds until more than `cap` children are alive at once (an uncapped scheduler gets
// there at once) or a second has passed (a capped one never does and waits it out). Passing never
// depends on speed: the assertions are the upper bound and that every unit ran exactly once.
const STAND_IN_RUNNER = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const unit = argv.find((a) => a.startsWith('--file=') || a.startsWith('--shard='));
const report = argv.find((a) => a.startsWith('--json=')).slice('--json='.length);
const { UNIT_LOG: log, UNIT_CAP: cap } = process.env;
appendFileSync(log, 'start ' + unit + '\\n');
const alive = () => {
  const lines = readFileSync(log, 'utf-8').split('\\n');
  return lines.filter((l) => l.startsWith('start ')).length - lines.filter((l) => l.startsWith('end ')).length;
};
const deadline = Date.now() + 1000;
while (alive() <= Number(cap) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 20));
}
appendFileSync(log, 'end ' + unit + '\\n');
writeFileSync(report, JSON.stringify({ passed: 1, failed: 0, failures: [], timings: [] }));
`;

test('parallel.mjs never runs more children at once than --jobs and runs every unit exactly once', () => {
  const cases = [
    { args: ['--by-file', '--jobs=2'], units: ['a', 'b', 'c', 'd', 'e'].map((x) => `--file=${x}`) },
    {
      args: ['--shards=5', '--jobs=2'],
      units: [1, 2, 3, 4, 5].map((i) => `--shard=${i}/5`),
    },
  ];
  for (const { args, units } of cases) {
    withTmpDir((dir) => {
      const tree = join(dir, 'tests');
      mkdirSync(tree);
      copyFileSync(PARALLEL, join(tree, 'parallel.mjs'));
      writeFileSync(join(tree, 'runner.mjs'), STAND_IN_RUNNER);
      for (const x of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(tree, `${x}.test.mjs`), '');
      const log = join(dir, 'units.log');
      writeFileSync(log, '');
      const r = spawnSync(process.execPath, [join(tree, 'parallel.mjs'), ...args], {
        encoding: 'utf-8',
        timeout: 60000,
        env: childEnv(dir, { UNIT_LOG: log, UNIT_CAP: '2' }),
      });
      const label = args.join(' ');
      assert.equal(r.error, undefined, `${label}: ${r.error}`);
      assert.equal(r.status, 0, `${label}: exit ${r.status} ${r.stderr}`);
      const events = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
      let alive = 0;
      let peak = 0;
      for (const e of events) {
        alive += e.startsWith('start ') ? 1 : -1;
        peak = Math.max(peak, alive);
      }
      assert.ok(peak <= 2, `${label}: ${peak} children alive at once, cap is 2`);
      for (const kind of ['start', 'end']) {
        const seen = events
          .filter((e) => e.startsWith(`${kind} `))
          .map((e) => e.slice(kind.length + 1));
        assert.deepEqual(seen.sort(), [...units].sort(), `${label}: ${kind} of every unit, once`);
      }
    });
  }
});
