/**
 * scripts/lib/pack-surface.mjs — pure helpers for the ship-surface gate.
 *
 * MAINTAINER-ONLY. Deliberately absent from package.json `files`; it must never
 * ship. Being in the repo and being in the product are different things.
 *
 * Two independent invariants, because either one alone rots:
 *
 *   1. surfaceDiff() — the tarball's file list must equal a checked-in snapshot.
 *      Catches drift in BOTH directions (a maintainer tool leaking out, a product
 *      file silently dropped). A snapshot alone is weak: a red CI can be turned
 *      green by regenerating it, which is how the previous "just add a negation"
 *      rule decayed.
 *
 *   2. closureViolations() — every import made by a SHIPPED .mjs must resolve to
 *      another SHIPPED file. This one cannot be regenerated away: the only way to
 *      satisfy it is to either ship the dependency (a visible package.json edit)
 *      or stop importing it. It is what makes the allow-list in `files` safe to
 *      invert — a product script left off the list fails loudly instead of
 *      vanishing from the tarball.
 *
 * Specifiers are found with a small scanner, not a regex over raw text. A regex
 * cannot tell `import('./x.mjs')` from the same characters sitting inside a
 * comment or a string, and it silently misses `import(`./lib/${name}.mjs`)` —
 * which loads a real module at runtime and would crash for anyone installing from
 * npm. An import the scanner cannot resolve statically is reported, never ignored:
 * the gate refuses to certify what it cannot see.
 */

const WORD = /[A-Za-z0-9_$]/;

/**
 * Walk `source` once, classifying every character as code, comment, or string.
 * Returns the string literals (with their cooked text and whether they contain a
 * `${}` substitution) plus a same-length mask marking which characters are code.
 */
function scan(source) {
  const isCode = new Array(source.length).fill(false);
  const strings = []; // { start, end, text, hasSubstitution }
  let i = 0;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      let text = '';
      let hasSubstitution = false;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          hasSubstitution = true;
          // Skip the substitution wholesale; nested braces are counted so a
          // `${ a ? '{' : '}' }` does not end the span early.
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
          }
          continue;
        }
        text += source[i];
        i++;
      }
      strings.push({ start, end: i, text, hasSubstitution });
      i++;
      continue;
    }

    isCode[i] = true;
    i++;
  }

  return { isCode, strings };
}

/** The string literal starting at the first non-space character at or after `pos`. */
function stringAt(source, strings, pos) {
  let i = pos;
  while (i < source.length && /\s/.test(source[i])) i++;
  return strings.find((s) => s.start === i) ?? null;
}

/** Every occurrence of `word` as a standalone identifier in code (not in a string or comment). */
function keywordPositions(source, isCode, word) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(word, from);
    if (at === -1) return out;
    from = at + word.length;
    if (!isCode[at]) continue;
    if (at > 0 && WORD.test(source[at - 1])) continue;
    const after = source[at + word.length];
    if (after !== undefined && WORD.test(after)) continue;
    out.push(at);
  }
}

/**
 * Every module specifier a source file imports, static or dynamic.
 *
 * Returns `{ specifiers, unanalyzable }`. `specifiers` holds the resolvable string
 * literals. `unanalyzable` holds dynamic imports whose target is computed at
 * runtime (a variable, or a template with a `${}` in it) — the gate cannot prove
 * where those land, so it reports them rather than assuming they are safe.
 */
export function moduleImports(source) {
  const { isCode, strings } = scan(source);
  const specifiers = new Set();
  const unanalyzable = [];

  // `... from '<spec>'` — covers `import x from`, `import {a} from`, `export * from`.
  for (const at of keywordPositions(source, isCode, 'from')) {
    const lit = stringAt(source, strings, at + 4);
    if (lit && !lit.hasSubstitution) specifiers.add(lit.text);
  }

  for (const at of keywordPositions(source, isCode, 'import')) {
    let i = at + 6;
    while (i < source.length && /\s/.test(source[i])) i++;

    if (source[i] === '(') {
      // Dynamic import. The specifier must be a literal with no substitution,
      // otherwise its target is only known at runtime.
      const lit = stringAt(source, strings, i + 1);
      if (!lit || lit.hasSubstitution) {
        const line = source.slice(0, at).split('\n').length;
        unanalyzable.push({ line, snippet: source.slice(at, at + 60).split('\n')[0] });
      } else {
        specifiers.add(lit.text);
      }
      continue;
    }

    // Side-effect import: `import './x.mjs'`. Anything else is a named/default
    // import, whose specifier the `from` pass above already picked up.
    const lit = strings.find((s) => s.start === i);
    if (lit && !lit.hasSubstitution) specifiers.add(lit.text);
  }

  return { specifiers: [...specifiers], unanalyzable };
}

/** Only the relative specifiers — the ones that must resolve inside the package. */
export function relativeImports(source) {
  return moduleImports(source).specifiers.filter((s) => s.startsWith('.'));
}

/**
 * Resolve `./lib/x.mjs` imported from `scripts/a.mjs` to `scripts/lib/x.mjs`.
 * Returns null when the path climbs out of the package root — that can never
 * resolve inside a tarball, so it is a violation rather than a resolution.
 */
export function resolveFrom(importerPath, specifier) {
  const parts = importerPath.split('/').slice(0, -1);
  for (const seg of specifier.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/**
 * npm's JSON array from `npm pack --json`, even when a lifecycle line printed a
 * stray bracket ahead of it. Walking the candidate `[` positions costs nothing and
 * removes a whole class of flake: trusting the first bracket makes the gate hostage
 * to anything npm or a lifecycle script decides to log.
 */
export function parsePackJson(stdout) {
  for (let at = stdout.indexOf('['); at !== -1; at = stdout.indexOf('[', at + 1)) {
    try {
      const parsed = JSON.parse(stdout.slice(at));
      if (Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0].files)) return parsed[0];
    } catch {
      // not the start of npm's array; keep looking
    }
  }
  throw new Error('npm pack --json produced no parsable file list');
}

/**
 * Exact set difference between the tarball and the snapshot.
 * `added` = shipping but not approved. `removed` = approved but no longer shipping.
 */
export function surfaceDiff(actualPaths, snapshotPaths) {
  const actual = new Set(actualPaths);
  const snapshot = new Set(snapshotPaths);
  return {
    added: [...actual].filter((p) => !snapshot.has(p)).sort(),
    removed: [...snapshot].filter((p) => !actual.has(p)).sort(),
  };
}

/**
 * Every import of a shipped .mjs must land inside the shipped set, and every
 * import must be statically resolvable in the first place.
 *
 * `readSource(path)` returns the file's text; it is injected so this stays pure
 * and unit-testable without touching disk.
 */
export function closureViolations(shippedPaths, readSource) {
  const shipped = new Set(shippedPaths);
  const violations = [];

  for (const path of shippedPaths) {
    if (!path.endsWith('.mjs')) continue;
    const source = readSource(path);
    const { specifiers, unanalyzable } = moduleImports(source);

    for (const u of unanalyzable) {
      violations.push({
        kind: 'unanalyzable',
        from: path,
        imports: u.snippet,
        resolved: `line ${u.line}`,
      });
    }

    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue; // bare / node: builtins are not ours
      const target = resolveFrom(path, spec);
      if (target === null) {
        violations.push({
          kind: 'escapes-root',
          from: path,
          imports: spec,
          resolved: '(outside the package root)',
        });
      } else if (!shipped.has(target)) {
        violations.push({ kind: 'missing', from: path, imports: spec, resolved: target });
      }
    }
  }

  return violations;
}
