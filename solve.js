// Fast drop-in for makefun-site 1.0.0 (make.fun site-generator-speed-01-run-20261122).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input: every page's index.html, the index and tag pages,
// build-report.txt and each static file, byte for byte. Written from the
// competition's README rules and the reference program's observable behaviour.
// One self-contained ES module: no imports, no dependencies, no eval, no
// caching of anything from one case to the next (all state lives in run()).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Escape the slice s[lo, hi) into the output array, in chunks. */
const ESC_RE = /[&<>"']/g;
function escRange(s, lo, hi, out) {
  if (lo >= hi) return;
  ESC_RE.lastIndex = lo;
  let at = lo;
  let m;
  while ((m = ESC_RE.exec(s)) !== null && m.index < hi) {
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push(ESC[m[0]]);
    at = m.index + 1;
  }
  if (at < hi) out.push(s.slice(at, hi));
}


/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- slug

/** Per-run cache: slugify is called on the same titles and tag names over and over. */
let slugCache = null;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // Pure ASCII text is unchanged by NFKD and holds no combining marks.
  const plain = /[^\x00-\x7F]/.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter: { data, lines, bodyStart }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue; // blank, or '#' comment
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const last = hi - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[lo, hi)` rendered inline into `out`; `env.link(target)` is a link's href. */
function inlineInto(s, lo, hi, env, out) {
  let i = lo;
  let lit = lo; // start of the pending literal run
  const flush = (to) => {
    if (to > lit) escRange(s, lit, to, out);
  };
  while (i < hi) {
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(s[i + 1]);
      i += 2;
      lit = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        flush(i);
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          lit = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      const m = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        const href = env.link(target);
        out.push('<a href="');
        escRange(href, 0, href.length, out);
        out.push('">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        lit = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(hi);
}

/**
 * The lines[ start .. ] rendered: HTML (each block on its own lines, a "\n"
 * after the last), table of contents (every level 2 and 3 heading) and excerpt
 * (the first paragraph's inline HTML, or "").
 */
/**
 * The lines[start..] rendered: HTML (each block on its own lines, a "\n"
 * after the last), table of contents (every level 2 and 3 heading), excerpt
 * (the first paragraph's inline HTML, or "") and wordCount (the body's words,
 * runs of characters other than whitespace).
 *
 * One pre-pass classifies every line and counts its words, so the block loop
 * never re-tests a line: a line's class is 0 other, 1 blank, 2 fence, 4
 * heading, 5 thematic break, 6 blockquote, 7 bullet item, 8 ordered item.
 * A fence line with no language is also a fence close (the two patterns
 * match the same lines), so the fence body stops on class 2 with lang ''.
 */
function renderMarkdown(lines, start, env) {
  const n = lines.length;
  const m = n - start;
  const cls = new Uint8Array(m);
  const headDepth = new Uint8Array(m);
  const headText = new Array(m);
  const fenceLang = new Array(m);
  const listText = new Array(m);
  const listStart = new Int32Array(m);
  let wordCount = 0;
  for (let k = 0; k < m; k++) {
    const line = lines[start + k];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c > 32) {
        // Non-whitespace, except the Unicode spaces above the ASCII range.
        if (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028
          || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) inWord = false;
        else if (!inWord) {
          inWord = true;
          wordCount++;
        }
      } else if (c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32) inWord = false;
      else if (!inWord) {
        inWord = true;
        wordCount++;
      }
    }
    let f;
    if (BLANK.test(line)) cls[k] = 1;
    else if ((f = FENCE_OPEN.exec(line)) !== null) {
      cls[k] = 2;
      fenceLang[k] = f[1];
    } else {
      const h = headingOf(line);
      if (h !== null) {
        cls[k] = 4;
        headDepth[k] = h.depth;
        headText[k] = h.text;
      } else if (HR_RE.test(line)) cls[k] = 5;
      else if (line.charCodeAt(0) === 62) cls[k] = 6; // '>'
      else if ((f = BULLET_RE.exec(line)) !== null) {
        cls[k] = 7;
        listText[k] = f[1];
      } else if ((f = ORDERED_RE.exec(line)) !== null) {
        cls[k] = 8;
        listText[k] = f[2];
        listStart[k] = Number(f[1]);
      } else cls[k] = 0;
    }
  }

  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  while (i < n) {
    const r = i - start;
    const c = cls[r];
    if (c === 1) {
      i++;
      continue;
    }
    if (c === 2) {
      const lang = fenceLang[r];
      const body = [];
      i++;
      while (i < n && !(cls[i - start] === 2 && fenceLang[i - start] === '')) body.push(lines[i++]);
      i++;
      const attr = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const parts = [`<pre><code${attr}>`];
      for (const l of body) {
        escRange(l, 0, l.length, parts);
        parts.push('\n');
      }
      parts.push('</code></pre>\n');
      blocks.push(parts.join(''));
      continue;
    }
    if (c === 4) {
      const text = headText[r];
      const depth = headDepth[r];
      const id = uniqueSlug(slugify(text), ids);
      const inner = [];
      inlineInto(text, 0, text.length, env, inner);
      const html = inner.join('');
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (c === 5) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (c === 6) {
      const body = [];
      while (i < n && cls[i - start] === 6) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        blocks.push('<blockquote>\n</blockquote>\n');
      } else {
        const joined = kept.join('\n');
        const inner = [];
        inlineInto(joined, 0, joined.length, env, inner);
        blocks.push(`<blockquote>\n<p>${inner.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    if (c === 7 || c === 8) {
      const isOrdered = c === 8;
      const startNum = isOrdered ? listStart[r] : 1;
      const items = [];
      while (i < n) {
        const rr = i - start;
        if (cls[rr] === (isOrdered ? 8 : 7)) {
          items.push([trimLine(listText[rr])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [`${open}\n`];
      for (const item of items) {
        const joined = item.join('\n');
        const inner = [];
        inlineInto(joined, 0, joined.length, env, inner);
        parts.push(`<li>${inner.join('')}</li>\n`);
      }
      parts.push(`</${tag}>\n`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(lines[i])];
    i++;
    while (i < n) {
      const cc = cls[i - start];
      if (cc === 1 || cc === 2 || cc === 4 || cc === 5) break;
      body.push(trimLine(lines[i++]));
    }
    const joined = body.join('\n');
    const inner = [];
    inlineInto(joined, 0, joined.length, env, inner);
    const html = inner.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', wordCount };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ k: 'text', t: text });
      text = '';
      tokens.push({ k: raw ? 'raw' : 'var', p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ k: 'text', t: text });
    text = '';
    tokens.push({ k: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ k: 'text', t: text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.k === 'text') body.push({ k: 'text', t: tok.t });
    else if (tok.k === 'var' || tok.k === 'raw') body.push({ k: tok.k, p: tok.p });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 'for', name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 'if', not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the parsed
 * templates, the HTML escape and the include depth. Loop frames are reused across
 * iterations: rendering is synchronous, so mutating one frame per loop is safe.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        out.push(n.t);
        break;
      case 'var': {
        const v = textOf(lookup(scope, n.p));
        if (v !== '') escRange(v, 0, v.length, out);
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scope, n.p)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.p));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.p);
        if (!Array.isArray(xs)) break;
        const vars = {};
        const frame = { vars, parent: scope };
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, frame, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.wordCount / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const card = cardOf(s);
  card.slug = s.slug;
  card.content = s.html;
  card.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  card.newer = linkOf(s.newer ?? null);
  card.older = linkOf(s.older ?? null);
  card.is_post = s.post;
  return card;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, env);
    s.wordCount = md.wordCount;
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
