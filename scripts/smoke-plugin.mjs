#!/usr/bin/env node
// smoke-plugin.mjs — a cheap, LOCAL structural check that the Claude Code plugin
// would load, with no network and no Claude CLI dependency (so it runs in CI). It
// validates the three surfaces Claude Code actually reads:
//   1. .claude-plugin/plugin.json  — manifest (name, version, commands/skills paths)
//   2. hooks/hooks.json            — every `${CLAUDE_PLUGIN_ROOT}/...` target must exist
//   3. component files             — commands/*.md and skills/*/SKILL.md must be REAL
//      (a .gitkeep alone is not a surface — a plugin with zero commands/skills must fail)
// plus marketplace↔plugin name parity and that the marketplace `source` resolves to a
// dir holding .claude-plugin/plugin.json.
//
// For a deep, real load check on a dev machine: `claude --plugin-dir . plugin list`.
// That needs Claude Code installed, so it is NOT used here; this is the CI floor.
//
// Usage:
//   node scripts/smoke-plugin.mjs               # smoke the repo's plugin
//   node scripts/smoke-plugin.mjs --root <dir>  # point at a fixture (tests)
//
// Exit 0 = plugin surfaces are structurally valid. Exit 1 = a load-blocking problem.

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = { root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--root=')) args.root = a.slice(7);
    else if (a === '--root') args.root = argv[++i];
  }
  return args;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function smoke(root) {
  const errors = [];
  const notes = [];
  const fail = (msg) => errors.push(msg);

  // 1. plugin.json manifest.
  let plugin = null;
  const pluginPath = join(root, '.claude-plugin', 'plugin.json');
  try {
    plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
  } catch (err) {
    fail(`.claude-plugin/plugin.json: ${err?.message ?? err}`);
  }
  if (plugin) {
    if (typeof plugin.name !== 'string' || !plugin.name) fail('plugin.json: missing "name"');
    if (typeof plugin.version !== 'string' || !plugin.version)
      fail('plugin.json: missing "version"');
    // commands/skills are declared as relative dir paths; if declared they must resolve.
    for (const key of ['commands', 'skills']) {
      if (plugin[key] != null) {
        const rel = String(plugin[key]).replace(/^\.\//, '');
        if (!isDir(join(root, rel)))
          fail(`plugin.json: "${key}" path "${plugin[key]}" is not a directory`);
      }
    }
  }

  // 2. Component files must be REAL regular files, not just a .gitkeep placeholder
  // (or a directory that happens to be named like a component — isFile, not exists).
  const commandsMd = isDir(join(root, 'commands'))
    ? readdirSync(join(root, 'commands')).filter(
        (f) => f.endsWith('.md') && isFile(join(root, 'commands', f)),
      )
    : [];
  if (commandsMd.length === 0) fail('commands/: no *.md command files (only a placeholder?)');
  else notes.push(`commands: ${commandsMd.length}`);

  const skillNames = [];
  if (isDir(join(root, 'skills'))) {
    for (const entry of readdirSync(join(root, 'skills'))) {
      if (isFile(join(root, 'skills', entry, 'SKILL.md'))) skillNames.push(entry);
    }
  }
  if (skillNames.length === 0) fail('skills/: no */SKILL.md skills (only a placeholder?)');
  else notes.push(`skills: ${skillNames.length}`);

  // The collision check below compares directory names against command filenames. That
  // only holds while a skill's invocation name IS its directory name. A `name:` in the
  // frontmatter overrides it, so `skills/bar/SKILL.md` declaring `name: foo` would claim
  // `/<plugin>:foo` and slip past a directory-name comparison. Rather than reimplement the
  // loader's name resolution here, keep the premise true: a `name:` must agree with the
  // directory. Omit it (as `skills/debate/SKILL.md` does) and the directory name stands.
  for (const entry of skillNames) {
    const head = readFileSync(join(root, 'skills', entry, 'SKILL.md'), 'utf-8').slice(0, 4096);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!fm) continue;
    const declared = /^name:[ \t]*(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(fm[1]);
    if (!declared) continue;
    const value = (declared[1] ?? declared[2] ?? declared[3] ?? '').trim();
    if (value && value !== entry)
      fail(
        `skills/${entry}/SKILL.md declares "name: ${value}" but sits in directory ` +
          `"${entry}". The invocation name must match the directory, or the collision ` +
          `check below compares the wrong names. Rename the directory or drop the field.`,
      );
  }

  // A flat `commands/<name>.md` and a directory `skills/<name>/SKILL.md` are both skill
  // components to the loader, and both claim the same `/<plugin>:<name>`. Shipping the
  // pair does not give one surface for people and another for the model: only one wins,
  // the other is dead weight that still costs always-on tokens and still shows up in the
  // component inventory. Six such pairs shipped for four months before anyone noticed.
  const commandNames = new Set(commandsMd.map((f) => f.replace(/\.md$/, '')));
  const collisions = skillNames.filter((n) => commandNames.has(n)).sort();
  if (collisions.length > 0)
    fail(
      `component name collision: ${collisions.join(', ')} — each exists as both ` +
        `commands/<name>.md and skills/<name>/SKILL.md, so both register the same ` +
        `/<plugin>:<name>. Keep exactly one surface per name.`,
    );

  // 3. hooks/hooks.json — every command target AND every `shared` file must be a
  // real regular file on disk. hooks.json is the hook source of truth, so a missing
  // hypo-shared.mjs / version-check.mjs would pass a manifest-only check but break
  // hook imports at runtime.
  const hooksPath = join(root, 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) {
    fail('hooks/hooks.json: missing');
  } else {
    let hooksJson = null;
    try {
      hooksJson = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    } catch (err) {
      fail(`hooks/hooks.json: ${err?.message ?? err}`);
    }
    if (hooksJson) {
      if (!hooksJson.hooks || typeof hooksJson.hooks !== 'object') {
        fail('hooks/hooks.json: missing top-level "hooks" object');
      } else {
        const targets = new Set();
        for (const groups of Object.values(hooksJson.hooks)) {
          for (const group of groups || []) {
            for (const hk of group?.hooks || []) {
              if (hk?.command) {
                // command looks like `node ${CLAUDE_PLUGIN_ROOT}/hooks/foo.mjs [args]`
                const m = String(hk.command).match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+)/);
                if (m) targets.add(m[1]);
              }
            }
          }
        }
        if (targets.size === 0)
          fail('hooks/hooks.json: no ${CLAUDE_PLUGIN_ROOT} command targets found');
        for (const rel of targets) {
          if (!isFile(join(root, rel))) fail(`hooks/hooks.json: target "${rel}" is not a file`);
        }
        notes.push(`hook targets: ${targets.size}`);
      }
      // `shared` lists hook-relative support files that the targets import.
      if (Array.isArray(hooksJson.shared)) {
        for (const shared of hooksJson.shared) {
          if (!isFile(join(root, 'hooks', shared)))
            fail(`hooks/hooks.json: shared file "hooks/${shared}" is not a file`);
        }
        notes.push(`shared: ${hooksJson.shared.length}`);
      }
    }
  }

  // 4. marketplace.json — name parity + source resolves.
  const mpPath = join(root, '.claude-plugin', 'marketplace.json');
  let mp = null;
  try {
    mp = JSON.parse(readFileSync(mpPath, 'utf-8'));
  } catch (err) {
    fail(`.claude-plugin/marketplace.json: ${err?.message ?? err}`);
  }
  if (mp) {
    const plugins = Array.isArray(mp.plugins) ? mp.plugins : [];
    if (plugins.length === 0) fail('marketplace.json: "plugins" is empty');
    const name = plugin?.name;
    if (name) {
      const matches = plugins.filter((p) => p && p.name === name);
      if (matches.length !== 1) {
        fail(
          `marketplace.json: expected exactly one entry named "${name}", found ${matches.length}`,
        );
      } else {
        const src = matches[0].source ?? './';
        const srcDir = join(root, String(src).replace(/^\.\//, ''));
        if (!existsSync(join(srcDir, '.claude-plugin', 'plugin.json'))) {
          fail(
            `marketplace.json: source "${src}" does not resolve to a dir containing .claude-plugin/plugin.json`,
          );
        }
      }
    }
  }

  return { errors, notes };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root || REPO_ROOT;
  const { errors, notes } = smoke(root);

  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(`\n✗ plugin smoke failed (${errors.length} problem(s)).`);
    process.exit(1);
  }
  console.log(`✓ plugin surfaces valid (${notes.join(', ')}).`);
  process.exit(0);
}

main();
