// Map the PR diff so findings can be anchored to lines the forge will accept an inline comment on.

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A `+++ ` header path as Git prints it (C-quoted when unusual, tab-terminated when it has spaces), without `b/`. */
export function diffPath(header) {
  let name = header.replace(/\t$/, '');
  if (name.startsWith('"') && name.endsWith('"')) {
    const bytes = [];
    const body = name.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '\\') { const ch = String.fromCodePoint(body.codePointAt(i)); bytes.push(...Buffer.from(ch)); i += ch.length - 1; continue; }
      const octal = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; }
      else { bytes.push(ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1)); i += 1; }
    }
    name = Buffer.from(bytes).toString('utf8');
  }
  return name.replace(/^b\//, '');
}

/**
 * Walk a unified diff line by line. Hunk headers give line counts, so content such as an added `++ x;` (printed
 * `+++ x;`) is never mistaken for a file header. Yields { kind, file, newLine, index, raw } where kind is one of
 * diff | header | hunk | meta | add | del | ctx | note, and newLine is set for add and ctx.
 */
export function* diffEntries(diffText) {
  let file = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = diffText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) { newLeft -= 1; yield { kind: 'add', file, newLine: line++, index, raw }; continue; }
      if (raw.startsWith('-')) { oldLeft -= 1; yield { kind: 'del', file, newLine: null, index, raw }; continue; }
      if (raw.startsWith('\\')) { yield { kind: 'note', file, newLine: null, index, raw }; continue; }
      oldLeft -= 1; newLeft -= 1;   // ' ' context (or a blank line whose space was stripped)
      yield { kind: 'ctx', file, newLine: line++, index, raw };
      continue;
    }
    if (raw === '') continue;       // the split after the last newline
    if (raw.startsWith('diff --git ')) { file = null; yield { kind: 'diff', file, newLine: null, index, raw }; continue; }
    if (raw.startsWith('--- ')) { yield { kind: 'header', file, newLine: null, index, raw }; continue; }
    if (raw.startsWith('+++ ')) {
      const name = diffPath(raw.slice(4));
      file = name === '/dev/null' ? null : name;
      yield { kind: 'header', file, newLine: null, index, raw };
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      line = Number(hunk[2]);
      yield { kind: 'hunk', file, newLine: null, index, raw };
      continue;
    }
    yield { kind: raw.startsWith('\\') ? 'note' : 'meta', file, newLine: null, index, raw };
  }
}

/**
 * Parse a unified diff. Returns Map<path, Set<lineNumber>> of new-side lines that appear in the
 * diff (added lines and context lines). Removed lines and deleted files are not commentable.
 */
export function diffLineMap(diffText) {
  const map = new Map();
  for (const e of diffEntries(diffText)) {
    if (!e.file) continue;
    if (e.kind === 'header') { if (!map.has(e.file)) map.set(e.file, new Set()); continue; }
    if (e.kind === 'add' || e.kind === 'ctx') map.get(e.file).add(e.newLine);
  }
  return map;
}

/**
 * Pick a commentable anchor for a finding: { path, line, start_line?, snapped }.
 * Returns null when the file is not in the diff at all.
 */
export function anchor(map, finding) {
  const lines = map.get(finding.file);
  if (!lines || lines.size === 0) return null;

  const nearest = (n) => [...lines].reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best));
  const wantedEnd = finding.line_end || finding.line_start;
  const end = lines.has(wantedEnd) ? wantedEnd : nearest(wantedEnd);

  let start = lines.has(finding.line_start) ? finding.line_start : undefined;
  if (start !== undefined && start >= end) start = undefined;

  // A multi-line comment needs every line in between to be in the diff too.
  if (start !== undefined) {
    for (let i = start; i <= end; i++) {
      if (!lines.has(i)) { start = undefined; break; }
    }
  }

  return { path: finding.file, line: end, start_line: start, snapped: end !== wantedEnd };
}
