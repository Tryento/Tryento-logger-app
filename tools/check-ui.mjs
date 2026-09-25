/**
 * check-ui.mjs — static checks on the .dc.html component.
 *
 * The DC format is interpreted at runtime, so a typo in a binding is invisible
 * until someone opens that screen on a phone. These checks are the substitute
 * for a compiler:
 *
 *  1. the logic script parses as JavaScript
 *  2. every `{{ root }}` the template consumes is actually produced by
 *     renderVals()
 *  3. no `{{ }}` binding uses a call or operator the mini-parser cannot handle
 *  4. the offline blockers stay fixed (no CDN fonts/scripts, fonts local)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'BSF Production Log.dc.html');

const src = await readFile(FILE, 'utf8');
const problems = [];
const notes = [];

/* ── split the document ─────────────────────────────────────────────────── */

const open = /<x-dc(?:\s[^>]*)?>/.exec(src);
const close = src.lastIndexOf('</x-dc>');
if (!open || close < 0) { console.error('no <x-dc> block found'); process.exit(1); }
const template = src.slice(open.index + open[0].length, close);

const scriptMatch = /<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/.exec(src);
if (!scriptMatch) { console.error('no data-dc-script block found'); process.exit(1); }
const logic = scriptMatch[1];

/* ── 1. the logic parses ────────────────────────────────────────────────── */

try {
  // Same shape the runtime uses (support.js:844): a function body with the
  // base class injected, returning the component.
  new vm.Script(
    `(function (DCLogic, StreamableLogic, React) {\n${logic}\n;return typeof Component !== "undefined" ? Component : undefined;})`,
    { filename: 'dc-script.js' }
  );
  notes.push(`logic script parses (${logic.split('\n').length} lines)`);
} catch (e) {
  problems.push(`logic script does NOT parse: ${e.message}`);
}

/* ── 2. bindings resolve ────────────────────────────────────────────────── */

const loopVars = new Set(['f', 'h']);
for (const m of template.matchAll(/\bas\s*=\s*"([A-Za-z_$][\w$]*)"/g)) loopVars.add(m[1]);

const produced = new Set();
// vals.foo = ...  and  vals.foo.bar = ...
for (const m of logic.matchAll(/\bvals\.([A-Za-z_$][\w$]*)\s*(?:=|\.)/g)) produced.add(m[1]);
// keys in `const vals = { foo: ..., bar: ... }` and Object.assign(vals, {...})
const valsLiteral = /const\s+vals\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(logic);
if (valsLiteral) {
  for (const m of valsLiteral[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/g)) produced.add(m[1]);
}
for (const m of logic.matchAll(/\bvals\[['"]([^'"]+)['"]\]/g)) produced.add(m[1]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const used = new Map();
for (const m of template.matchAll(/\{\{([^}]*)\}\}/g)) {
  const expr = m[1].trim();
  if (!expr) continue;

  // The template mini-parser (support.js expr.ts) supports paths, [] indexing,
  // !, and equality only. Anything else silently renders nothing.
  if (/[()+\-*/%?]|&&|\|\|/.test(expr.replace(/!==?|===?/g, ''))) {
    problems.push(`binding uses an unsupported expression: {{ ${expr} }}`);
    continue;
  }

  for (const part of expr.split(/\s*(?:!==?|===?)\s*/)) {
    const token = part.replace(/^!+/, '').trim();
    if (!token || LITERALS.has(token) || /^-?\d/.test(token) || /^['"]/.test(token)) continue;
    const root = token.split(/[.[]/)[0];
    if (!root || loopVars.has(root)) continue;
    if (!used.has(root)) used.set(root, expr);
  }
}

const missing = [...used.keys()].filter(k => !produced.has(k)).sort();
if (missing.length) {
  for (const k of missing) problems.push(`template binds {{ ${used.get(k)} }} but renderVals never sets "${k}"`);
} else {
  notes.push(`all ${used.size} template bindings resolve`);
}

const unused = [...produced].filter(k => !used.has(k) && !/^(is|show)/.test(k)).sort();
if (unused.length) notes.push(`set but unused (harmless): ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? ` +${unused.length - 8}` : ''}`);

/* ── 3. offline blockers stay fixed ─────────────────────────────────────── */

const head = src.slice(0, open.index);
// Only flag a real remote reference, not prose in a comment explaining why
// there is no longer one.
const withoutComments = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (/(?:href|src)\s*=\s*"[^"]*fonts\.(?:googleapis|gstatic)\.com/.test(withoutComments)) {
  problems.push('still references Google Fonts — the app cannot render offline');
}
if (/(?:src|href)\s*=\s*"https?:\/\//.test(withoutComments)) {
  problems.push('still loads an asset from a CDN — the app cannot boot offline');
}
if (!/fonts\/fonts\.css/.test(src)) problems.push('local fonts stylesheet is not linked');
if (!/rel="manifest"/.test(head)) problems.push('PWA manifest is not linked');
if (!/serviceWorker/.test(head)) problems.push('service worker is never registered');
if (!/vendor\/react\.production\.min\.js/.test(head)) problems.push('React is not self-hosted');

/* ── 4. regressions that must stay fixed ────────────────────────────────── */

if (/estado\s*===\s*'activa'|ESTADO_BANDEJA\.activa\b/.test(logic)) {
  problems.push("still uses the old two-state tray model ('activa')");
}
// prompt/alert/confirm are BLOCKED in installed PWAs on iOS, which is the app's
// delivery mode. Closing an ayuno was impossible there and the tray stayed
// "EN AYUNO" with no way out. Use this.ask() instead.
{
  // Work line by line and skip comment lines, so the comment explaining the
  // ban does not trip the ban.
  const codeLines = logic.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const fn of ['prompt', 'alert', 'confirm']) {
    const re = new RegExp(`(?<![\\w.])(?:window\\.)?${fn}\\s*\\(`);
    const hit = codeLines.find(l => re.test(l));
    if (hit) {
      problems.push(`llama a ${fn}(), que no funciona en una PWA instalada en iOS — usa this.ask()  [${hit.trim().slice(0, 60)}]`);
    }
  }
}

if (/photoName:\s*file\.name|qcPhotoName:\s*file\.name/.test(logic)) {
  problems.push('photo capture still stores only the filename and discards the image');
}
if (/showQcPanel:\s*lote\.estado === 'secando'\s*,/.test(logic)) {
  problems.push('QC panel is still gated on secando alone — a typo in peso_final_kg would be uncorrectable');
}

/* ── report ─────────────────────────────────────────────────────────────── */

for (const n of notes) console.log(`  ok    ${n}`);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\n${problems.length} problem(s).`);
  process.exitCode = 1;
} else {
  console.log('\nUI checks passed.');
}
