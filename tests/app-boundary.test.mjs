// tests/app-boundary.test.mjs
//
// Covers scripts/app-boundary.mjs and scripts/lib/app-boundary.mjs: the entry point an app uses to
// leave one wiki entry per task boundary as a local commit. Every process started here gets HOME
// and HYPO_DIR pinned to a temp dir, so nothing touches a real vault.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIdFor } from '../scripts/lib/app-boundary.mjs';
import { formatSessionEntry } from '../hooks/session-entries.mjs';
import { test, testAsync, suite } from './harness.mjs';
import { REPO, withTmpDir } from './helpers.mjs';

const CLI = join(REPO, 'scripts', 'app-boundary.mjs');
const LIB = join(REPO, 'scripts', 'lib', 'app-boundary.mjs');
const SHARED = join(REPO, 'hooks', 'hypo-shared.mjs');
const IDENTITY = '임상규 139614336+sk-lim19f@users.noreply.github.com';

const BOOK = {
  projects: { 'security-backoffice': '보안 백오피스 프로젝트' },
  teams: { design: '디자인 팀', po: '제품 팀', backend: '백엔드 팀' },
  taskKind: { feature: '기능 작업' },
  decision: { 'no-decision': '결정할 일이 없었다', 'ask-human': '사람에게 물었다' },
  status: { done: '작업이 끝났다', blocked: '작업이 막혔다' },
  boundaryKind: { 'task-end': '작업 경계에서 남긴 기록', 'task-start': '작업을 시작했다' },
};
const PAYLOAD = {
  taskKind: 'feature',
  decision: 'no-decision',
  status: 'done',
  team: 'design',
  boundaryKind: 'task-end',
};
const BOUNDARY = 'ade:T-prodadmin-10.20.0.0/16-7f3a:task-end:1';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A vault with one commit, `.cache/` ignored and a bare origin, and a codebook file beside it.
function makeAb(home) {
  const vault = join(home, 'vault');
  const remote = join(home, 'remote.git');
  const env = { ...process.env, HOME: home, HYPO_DIR: vault };
  const git = (...a) => spawnSync('git', ['-C', vault, ...a], { encoding: 'utf-8', env });
  mkdirSync(vault);
  spawnSync('git', ['init', '-q', '--bare', remote], { env });
  git('init', '-q');
  git('config', 'user.email', 't@t.test');
  git('config', 'user.name', 'test');
  writeFileSync(join(vault, '.gitignore'), '.cache/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD');
  const bytes = JSON.stringify(BOOK);
  const codebook = join(home, 'wiki-codebook.json');
  writeFileSync(codebook, bytes);
  const argv = (o) => [
    CLI,
    'write',
    '--project=security-backoffice',
    `--boundary-id=${o.boundaryId}`,
    `--codebook=${o.codebook}`,
    `--codebook-sha256=${o.hash}`,
    `--hypo-dir=${vault}`,
    '--json',
  ];
  const opts = (over) => ({
    boundaryId: BOUNDARY,
    payload: PAYLOAD,
    codebook,
    hash: sha(bytes),
    ...over,
  });
  const call = (over = {}, extraEnv = {}, nodeArgs = []) => {
    const o = opts(over);
    const r = spawnSync(process.execPath, [...nodeArgs, ...argv(o)], {
      encoding: 'utf-8',
      env: { ...env, ...extraEnv },
      input: JSON.stringify(o.payload),
    });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { ...r, json };
  };
  const spawnCall = (over = {}) => {
    const o = opts(over);
    const child = spawn(process.execPath, argv(o), { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end(JSON.stringify(o.payload));
    const closed = new Promise((r) => child.on('close', (code) => r({ code, out })));
    return { closed };
  };
  return { home, vault, remote, env, git, call, spawnCall, codebook, bytes };
}

// Test-only fault injection for the marker update that follows the commit: a replacement of an
// existing marker file either kills the process or throws, as HYPO_TEST_APP_BOUNDARY_FAULT says.
function faultPreload(home) {
  const preload = join(home, 'marker-fault.cjs');
  writeFileSync(
    preload,
    `'use strict';
const fs = require('node:fs');
const real = fs.renameSync;
fs.renameSync = function (from, to) {
  const mode = process.env.HYPO_TEST_APP_BOUNDARY_FAULT;
  if (mode && typeof to === 'string' && /app-boundaries[\\/][^\\/]+\.json$/.test(to) && fs.existsSync(to)) {
    if (mode === 'after-commit-before-marker') process.kill(process.pid, 'SIGKILL');
    if (mode === 'marker-rename-throws') throw Object.assign(new Error('injected'), { code: 'EIO' });
  }
  return real.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  return preload;
}

// A killed process leaves its lock behind; a dead holder's lock is taken over once it is old.
const ageLock = (vault) => {
  const old = new Date(Date.now() - 120000);
  utimesSync(join(vault, '.cache', 'vault-commit.lock'), old, old);
};

const withAb = (fn) => withTmpDir((home) => fn(makeAb(home)));

const head = (git) => git('rev-parse', 'HEAD').stdout.trim();
const count = (git) => Number(git('rev-list', '--count', 'HEAD').stdout);
const markerDir = (vault) => join(vault, '.cache', 'app-boundaries');
const markerFiles = (vault) => (existsSync(markerDir(vault)) ? readdirSync(markerDir(vault)) : []);
// The vault is as it was: same HEAD, nothing dirty, no marker, no entry directory.
const untouched = (c, before) => {
  assert.equal(head(c.git), before);
  assert.equal(c.git('status', '--porcelain').stdout, '');
  assert.deepEqual(markerFiles(c.vault), []);
  assert.equal(existsSync(join(c.vault, 'projects')), false);
};

suite('app boundary: write and capabilities');

test('(1) the same boundary id twice makes one entry and one commit, the second reused', () => {
  withAb((c) => {
    const first = c.call();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(first.json.reused, false);
    assert.equal(first.json.state, 'committed');
    assert.match(first.json.closeId, /^ade-[0-9a-f]{24}$/);
    assert.equal(first.json.committedSha, head(c.git));
    const second = c.call();
    assert.equal(second.status, 0);
    assert.equal(second.json.reused, true);
    assert.equal(second.json.committedSha, first.json.committedSha);
    assert.equal(count(c.git), 2);
    assert.equal(
      readdirSync(join(c.vault, 'projects', 'security-backoffice', 'sessions')).length,
      1,
    );
  });
});

test('(2) a file a person staged stays staged and out of the commit', () => {
  withAb((c) => {
    writeFileSync(join(c.vault, 'human.md'), 'mine\n');
    c.git('add', 'human.md');
    const r = c.call();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(c.git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n'), [
      r.json.entryPath,
    ]);
    assert.equal(c.git('diff', '--cached', '--name-only').stdout.trim(), 'human.md');
  });
});

await testAsync(
  '(3) a held vault-commit lock: write waits, or names a timeout and changes nothing',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hypo-ab-'));
    let holder;
    try {
      const c = makeAb(home);
      const ready = join(home, 'holder.ready');
      const release = join(home, 'holder.release');
      holder = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { withFileLock, vaultCommitLockTarget } from ${JSON.stringify(SHARED)};
import { existsSync, writeFileSync } from 'node:fs';
withFileLock(vaultCommitLockTarget(${JSON.stringify(c.vault)}), () => {
  writeFileSync(${JSON.stringify(ready)}, '1');
  for (let i = 0; i < 600 && !existsSync(${JSON.stringify(release)}); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});`,
        ],
        { env: c.env },
      );
      const holderClosed = new Promise((r) => holder.on('close', r));
      for (let i = 0; i < 200 && !existsSync(ready); i++) await sleep(50);
      assert.ok(existsSync(ready), 'the holder never took the lock');
      const before = head(c.git);

      const timedRun = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { writeBoundary } from ${JSON.stringify(LIB)};
console.log(JSON.stringify(writeBoundary(${JSON.stringify({
            hypoDir: c.vault,
            project: 'security-backoffice',
            boundaryId: BOUNDARY,
            payload: PAYLOAD,
            codebookPath: c.codebook,
            codebookSha256: sha(c.bytes),
            lockTimeoutMs: 200,
          })})));`,
        ],
        { encoding: 'utf-8', env: c.env },
      );
      const timed = JSON.parse(timedRun.stdout);
      assert.deepEqual(timed, { error: 'vault_lock_timeout' });
      untouched(c, before);

      const waiting = c.spawnCall();
      await sleep(700);
      untouched(c, before);
      writeFileSync(release, '1');
      const { code, out } = await waiting.closed;
      assert.equal(code, 0, out);
      assert.equal(JSON.parse(out).reused, false);
      assert.equal(count(c.git), 2);
      await holderClosed;
    } finally {
      holder?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('(4) an unknown key, a code outside the code book and a digit in a template are refused before any write', () => {
  withAb((c) => {
    const before = head(c.git);
    const cases = [
      [{ payload: { ...PAYLOAD, extra: 'design' } }, 'invalid_payload'],
      [{ payload: { ...PAYLOAD, boundaryKind: undefined } }, 'invalid_payload'],
      [{ payload: { ...PAYLOAD, team: 'prodadmin' } }, 'code_not_in_codebook'],
    ];
    for (const [over, error] of cases) {
      const r = c.call(over);
      assert.deepEqual(r.json, { error }, r.stdout + r.stderr);
      assert.equal(r.status, 1);
      untouched(c, before);
    }
    const bad = JSON.stringify({ ...BOOK, status: { done: '버전 2 작업이 끝났다' } });
    const badPath = join(c.home, 'bad.json');
    writeFileSync(badPath, bad);
    const r = c.call({ codebook: badPath, hash: sha(bad) });
    assert.deepEqual(r.json, { error: 'codebook_invalid' });
    untouched(c, before);
  });
});

test('(5) a process killed after the commit and before the marker update finishes with no new commit', () => {
  withAb((c) => {
    const preload = faultPreload(c.home);
    const crashed = c.call({}, { HYPO_TEST_APP_BOUNDARY_FAULT: 'after-commit-before-marker' }, [
      '-r',
      preload,
    ]);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stdout + crashed.stderr);
    const [name] = markerFiles(c.vault);
    const marker = () => JSON.parse(readFileSync(join(markerDir(c.vault), name), 'utf-8'));
    assert.equal(marker().state, 'writing');
    assert.equal(count(c.git), 2);
    ageLock(c.vault);

    const again = c.call();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(again.json.reused, true);
    assert.equal(again.json.committedSha, head(c.git));
    assert.equal(count(c.git), 2);
    assert.equal(marker().state, 'committed');
    assert.equal(marker().committedSha, head(c.git));
  });
});

test('(6) the same boundary id with another payload is refused and the vault stays', () => {
  withAb((c) => {
    assert.equal(c.call().status, 0);
    const before = head(c.git);
    const r = c.call({ payload: { ...PAYLOAD, status: 'blocked' } });
    assert.deepEqual(r.json, { error: 'boundary_payload_mismatch' });
    assert.equal(head(c.git), before);
    assert.equal(c.git('status', '--porcelain').stdout, '');
  });
});

test('(7) an open merge or an unmerged index only: nothing is written, no marker', () => {
  withAb((c) => {
    const before = head(c.git);
    writeFileSync(join(c.vault, '.git', 'MERGE_HEAD'), `${before}\n`);
    let r = c.call();
    assert.deepEqual(r.json, { error: 'vault_operation_in_progress' });
    untouched(c, before);
    rmSync(join(c.vault, '.git', 'MERGE_HEAD'));

    const oid = (text) =>
      spawnSync('git', ['-C', c.vault, 'hash-object', '-w', '--stdin'], {
        encoding: 'utf-8',
        input: text,
        env: c.env,
      }).stdout.trim();
    const info = [1, 2, 3].map((n) => `100644 ${oid(`v${n}\n`)} ${n}\tconflict.txt\n`).join('');
    spawnSync('git', ['-C', c.vault, 'update-index', '--index-info'], { input: info, env: c.env });
    assert.notEqual(c.git('ls-files', '-u').stdout, '', 'the fixture has no unmerged entry');
    r = c.call();
    assert.deepEqual(r.json, { error: 'vault_operation_in_progress' });
    assert.equal(head(c.git), before);
    assert.deepEqual(markerFiles(c.vault), []);
    assert.equal(existsSync(join(c.vault, 'projects')), false);
  });
});

test('(8) no boundary id, task id, team name or address on the public surface; identity is fixed', () => {
  withAb((c) => {
    const r = c.call();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const surface = [
      r.stdout,
      c.git('ls-files').stdout,
      readFileSync(join(c.vault, r.json.entryPath), 'utf-8'),
      c.git('log', '-1', '--format=%B').stdout,
      c.git('log', '-1', '--format=%an %ae %cn %ce').stdout,
    ].join('\n');
    for (const secret of [BOUNDARY, 'T-prodadmin', '7f3a', 'prodadmin', '10.20.0.0/16']) {
      assert.equal(surface.includes(secret), false, `${secret} reached the surface`);
    }
    assert.equal(
      c.git('log', '-1', '--format=%an %ae %cn %ce').stdout.trim(),
      `${IDENTITY} ${IDENTITY}`,
    );
    const entry = readFileSync(join(c.vault, r.json.entryPath), 'utf-8');
    assert.match(entry, new RegExp(`close_id: ${r.json.closeId}\\n`));
    assert.match(entry, /tracks: \[\{"id":"design"\}\]/);
    assert.equal(/session_id|visibility_scope/.test(entry), false);
    assert.match(entry, /작업 경계에서 남긴 기록\n기능 작업\n결정할 일이 없었다\n작업이 끝났다/);
  });
});

test('(9) a code book that differs by one byte from the given hash is refused, vault and marker stay', () => {
  withAb((c) => {
    const before = head(c.git);
    writeFileSync(c.codebook, `${c.bytes} `);
    const r = c.call();
    assert.deepEqual(r.json, { error: 'codebook_mismatch' });
    untouched(c, before);
  });
});

test('(10) a committed boundary is reused under another code book hash, with no new commit', () => {
  withAb((c) => {
    const first = c.call();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const next = JSON.stringify({ ...BOOK, status: { ...BOOK.status, done: '작업을 마쳤다' } });
    const nextPath = join(c.home, 'next.json');
    writeFileSync(nextPath, next);
    // The app passes the hash the row was made under; the file on disk has moved on since.
    const again = c.call({ codebook: nextPath });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(again.json.reused, true);
    assert.equal(again.json.committedSha, first.json.committedSha);
    assert.equal(count(c.git), 2);
    // A boundary that never committed is another matter: the same mismatch is a refusal.
    const fresh = c.call({ boundaryId: 'ade:T-other:task-end:1', codebook: nextPath });
    assert.deepEqual(fresh.json, { error: 'codebook_mismatch' });
  });
});

test('(11) --capabilities names the protocol and nothing else', () => {
  const r = spawnSync(process.execPath, [CLI, '--capabilities', '--json'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: join(tmpdir(), 'hypo-ab-nohome'),
      HYPO_DIR: join(tmpdir(), 'hypo-ab-novault'),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['app-boundary/1']);
});

test('(12) no remote function is imported, no remote git command is named, the origin does not move', () => {
  const sources = [CLI, LIB].map((f) => readFileSync(f, 'utf-8'));
  const remoteNames = [...readFileSync(SHARED, 'utf-8').matchAll(/^export function (\w+)/gm)]
    .map((m) => m[1])
    .filter((n) => /pull|push|sync/i.test(n));
  for (const known of ['pullRemote', 'pushRemote', 'syncRemote'])
    assert.ok(remoteNames.includes(known), known);
  for (const src of sources) {
    const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    );
    assert.deepEqual(
      imported.filter((n) => remoteNames.includes(n)),
      [],
    );
    assert.equal(
      /import\s*\*|import\(|require\(/.test(src),
      false,
      'a namespace or dynamic import hides the list',
    );
    assert.equal(
      /['"`](push|pull|fetch|merge)['"`]/.test(src),
      false,
      'a remote git subcommand is named',
    );
  }
  withAb((c) => {
    const refs = () =>
      spawnSync('git', ['--git-dir', c.remote, 'for-each-ref'], { encoding: 'utf-8', env: c.env })
        .stdout;
    const tracking = () => c.git('for-each-ref', 'refs/remotes').stdout;
    const [remoteBefore, trackingBefore] = [refs(), tracking()];
    assert.equal(c.call().status, 0);
    assert.equal(count(c.git), 2);
    assert.equal(refs(), remoteBefore);
    assert.equal(tracking(), trackingBefore);
  });
});

// A writing marker as a call leaves it before its commit: stored bytes, no entry file, no commit.
function seedWritingMarker(c) {
  const closeId = closeIdFor(BOUNDARY);
  const closedAt = new Date().toISOString();
  const entryPath = `projects/security-backoffice/sessions/${closedAt.slice(0, 10)}-${closeId}.md`;
  const rendered = formatSessionEntry({
    project: 'security-backoffice',
    closeId,
    date: closedAt.slice(0, 10),
    closedAt,
    tracks: [{ id: PAYLOAD.team }],
    summary: '작업 경계에서 남긴 기록',
  });
  const payload = Object.fromEntries(
    Object.entries({ project: 'security-backoffice', ...PAYLOAD }).sort(),
  );
  mkdirSync(markerDir(c.vault), { recursive: true });
  writeFileSync(
    join(markerDir(c.vault), `${closeId}.json`),
    JSON.stringify({
      state: 'writing',
      closeId,
      entryPath,
      rendered,
      renderedSha256: sha(rendered),
      closedAt,
      payloadSha256: sha(JSON.stringify(payload)),
      codebookSha256: sha(c.bytes),
    }),
  );
  return { closeId, entryPath, rendered, markerFile: join(markerDir(c.vault), `${closeId}.json`) };
}

suite('app boundary: history moved, marker faults, code book rules, lock diagnostics');

test('a marker update that throws after a verified commit still reports the commit; the next call settles the marker', () => {
  withAb((c) => {
    const preload = faultPreload(c.home);
    const r = c.call({}, { HYPO_TEST_APP_BOUNDARY_FAULT: 'marker-rename-throws' }, ['-r', preload]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.reused, false);
    assert.equal(r.json.committedSha, head(c.git));
    const [name] = markerFiles(c.vault).filter((f) => f.endsWith('.json'));
    const marker = () => JSON.parse(readFileSync(join(markerDir(c.vault), name), 'utf-8'));
    assert.equal(marker().state, 'writing');
    const again = c.call();
    assert.equal(again.json.reused, true);
    assert.equal(again.json.committedSha, r.json.committedSha);
    assert.equal(count(c.git), 2);
    assert.equal(marker().state, 'committed');
  });
});

test('a committed marker is not trusted once HEAD no longer holds the entry', () => {
  withAb((c) => {
    assert.equal(c.call().status, 0);
    c.git('reset', '-q', '--hard', 'HEAD~1');
    const before = head(c.git);
    const r = c.call();
    assert.deepEqual(r.json, { error: 'entry_not_committed' });
    assert.equal(head(c.git), before);
    assert.equal(existsSync(join(c.vault, 'projects')), false);
  });
});

test('a person who edited and committed the entry after a crash is not overwritten', () => {
  withAb((c) => {
    const preload = faultPreload(c.home);
    const crashed = c.call({}, { HYPO_TEST_APP_BOUNDARY_FAULT: 'after-commit-before-marker' }, [
      '-r',
      preload,
    ]);
    assert.equal(crashed.signal, 'SIGKILL');
    ageLock(c.vault);
    const entry = c.git('show', '--name-only', '--format=', 'HEAD').stdout.trim();
    writeFileSync(
      join(c.vault, entry),
      `${readFileSync(join(c.vault, entry), 'utf-8')}\n사람이 고친 줄\n`,
    );
    c.git('add', entry);
    c.git('commit', '-q', '-m', 'edit');
    const [before, text] = [head(c.git), readFileSync(join(c.vault, entry), 'utf-8')];
    const r = c.call();
    assert.deepEqual(r.json, { error: 'entry_conflict' });
    assert.equal(head(c.git), before);
    assert.equal(readFileSync(join(c.vault, entry), 'utf-8'), text);
  });
});

test('a code book is refused for a full-width digit, a Roman numeral, an invisible character or a size over the cap', () => {
  withAb((c) => {
    const before = head(c.git);
    const long = '가'.repeat(201);
    const bad = {
      '전각 숫자와 기호': { status: { done: '대역 １０．２０．０．０／１６' } },
      '전각 기호만(NFKC에서만 드러남)': { status: { done: '계정 ａ＠ｂ' } },
      '숫자 속성을 잃는 글자': { status: { done: '단계 Ⅹ 완료' } },
      '보이지 않는 글자': { status: { done: '작업이\u200b끝났다' } },
      '공백뿐인 문장': { status: { done: '   ' } },
      '문장 200자 초과': { status: { done: long } },
      '코드 32자 초과': {
        status: { [`${'a'.repeat(33)}`]: '작업이 끝났다', done: '작업이 끝났다' },
      },
    };
    for (const [label, over] of Object.entries(bad)) {
      const text = JSON.stringify({ ...BOOK, ...over });
      const file = join(c.home, 'bad.json');
      writeFileSync(file, text);
      const r = c.call({ codebook: file, hash: sha(text) });
      assert.deepEqual(r.json, { error: 'codebook_invalid' }, label);
      untouched(c, before);
    }
    // 200 characters exactly is allowed.
    const edge = JSON.stringify({ ...BOOK, status: { done: '가'.repeat(200) } });
    const file = join(c.home, 'edge.json');
    writeFileSync(file, edge);
    assert.equal(c.call({ codebook: file, hash: sha(edge) }).status, 0);
  });
});

test('taking over an old lock prints a fixed line, never the vault path', () => {
  withAb((c) => {
    const lock = join(c.vault, '.cache', 'vault-commit.lock');
    mkdirSync(join(c.vault, '.cache'), { recursive: true });
    writeFileSync(lock, '99999999\n');
    ageLock(c.vault);
    const r = c.call();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /diagnostic omitted/, 'the takeover path did not run');
    assert.equal(r.stderr.includes(c.vault), false);
    assert.equal(r.stderr.includes(c.home), false);
  });
});

test('a staged deletion of a file with the entry bytes is not taken into the commit as a rename source', () => {
  withAb((c) => {
    // Recovery state: a writing marker, the entry in the work tree and the index, and a person's
    // staged deletion of human.md, whose bytes equal the entry's.
    const { entryPath, rendered } = seedWritingMarker(c);
    writeFileSync(join(c.vault, 'human.md'), rendered);
    c.git('add', 'human.md');
    c.git('commit', '-q', '-m', 'human file');
    c.git('rm', '-q', 'human.md');
    mkdirSync(join(c.vault, 'projects', 'security-backoffice', 'sessions'), { recursive: true });
    writeFileSync(join(c.vault, entryPath), rendered);
    c.git('add', entryPath);
    assert.match(
      c.git('status', '--porcelain').stdout,
      /^R /m,
      'the fixture is not read as a rename',
    );

    const r = c.call();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(c.git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n'), [
      entryPath,
    ]);
    assert.equal(c.git('diff', '--cached', '--name-only').stdout.trim(), 'human.md');
  });
});

test('a writing marker whose commit a person reset away is not written again', () => {
  withAb((c) => {
    assert.equal(c.call().status, 0);
    const [name] = markerFiles(c.vault);
    const file = join(markerDir(c.vault), name);
    // As if the checks after the commit had failed: the marker still says writing.
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), state: 'writing' }),
    );
    c.git('reset', '-q', '--hard', 'HEAD~1');
    const before = head(c.git);
    const r = c.call();
    assert.deepEqual(r.json, { error: 'entry_not_committed' });
    assert.equal(head(c.git), before);
    assert.equal(c.git('status', '--porcelain').stdout, '');
    assert.equal(existsSync(join(c.vault, 'projects')), false);
  });
});

test('a writing marker that never reached a commit is written and committed on the next call', () => {
  withAb((c) => {
    const { entryPath } = seedWritingMarker(c);
    const r = c.call();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.reused, false);
    assert.equal(r.json.entryPath, entryPath);
    assert.equal(count(c.git), 2);
  });
});

test('a failed history or blob lookup is not taken as proof that nothing was committed', () => {
  withAb((c) => {
    const real = spawnSync('which', ['git'], { encoding: 'utf-8' }).stdout.trim();
    for (const failing of ['--reflog', 'ls-tree']) {
      const bin = join(c.home, `bin-${failing.replace(/\W/g, '')}`);
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${failing}" ] && exit 128; done\nexec ${real} "$@"\n`,
        { mode: 0o755 },
      );
      const { markerFile } = seedWritingMarker(c);
      const before = head(c.git);
      const r = c.call({}, { PATH: `${bin}:${process.env.PATH}` });
      assert.deepEqual(r.json, { error: 'entry_not_committed' }, failing);
      assert.equal(head(c.git), before, failing);
      assert.equal(existsSync(join(c.vault, 'projects')), false, failing);
      rmSync(markerFile);
    }
  });
});
