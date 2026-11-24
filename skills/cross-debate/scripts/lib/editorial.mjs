import { git, scanDiffForSecrets } from './common.mjs';

const docPath = /^(?:readme\.md|changelog\.md|docs\/(?:[\w-]+\/)*[\w-]+\.md)$/i;
const operational = /\b(?:commands?|runbooks?|instructions?|deploy\w*|rollout|rollback|cleanup|delet\w*|remov\w*|eras\w*|purg\w*|destroy\w*|permissions?|sharing|visibility|private|public|access|grants?|roles?|admins?|owners?|approv\w*|authoriz\w*|privileges?|production|can(?:not)?|may|must|shall|allow\w*|den(?:y|ied|ies)|forbid\w*)\b/i;
const commandClause = /(?:^|[.,;:!?]\s*|\b(?:and|or|then|to|should)\s+)(?:please\s+)?(?:run|execute|type|invoke|install|reboot|restart|push|apply|enable|disable|set|grant|revoke|use)\b/i;
const plainText = /^(?:[-*] )?[\p{L}\p{N}][\p{L}\p{M}\p{N} ,.:!?'’"()–—-]*$/u;
const releaseNote = /^[-*] (?:[\p{L}-]+(?: [\p{L}-]+){0,5} (?:now|returns?|shows?|supports?|includes?|preserves?|displays?) |(?:Added|Changed|Fixed|Improved|Clarified|Corrected|Updated) )/u;
const setextUnderline = /^ {0,3}(=+|-+)[ \t]*$/;

function operativeText(text) {
  return operational.test(text) || commandClause.test(text.replace(/^[-*] /, ''))
    || (/\b(?:only|all|any|every|everyone|anyone|authors?|members?|users?|guests?|viewers?|editors?|staff)\b/i.test(text)
        && /\b(?:see|sees|seen|visible|views?|reads?|writes?|edits?|shares?|publish(?:es|ed)?)\b/i.test(text))
    || /(?:^|\s)-(?:-|[a-z0-9])|\b(?:python[\d.]*|node|ruby|perl|bash|zsh|sh|sudo|chmod|chown|kubectl|terraform|npm|make|git|rm)\s+\S/i.test(text);
}

function narrativeText(lines, changelog = false) {
  const listItem = /^\s*(?:\d+[.)]|[-+*])(?:\s|$)/;
  if (lines.some(line => setextUnderline.test(line) || (listItem.test(line) && !(changelog && releaseNote.test(line))))) return false;
  const text = lines.join(' ');
  const body = text.replace(/^[-*] /, '');
  const bareCommand = /^[a-z][\w.-]*(?:\s+[\w./-]+)*$/.test(body) && !/[.!?]$/.test(body);
  return plainText.test(text) && !bareCommand && !operativeText(text);
}

function editorialPath(file) {
  const words = file.replace(/[._/-]/g, ' ');
  return docPath.test(file) && !/\b(?:agents?|skills?|claude|prompts?)\b/i.test(words) && !operativeText(words);
}

function plainParagraphEnd(lines, at, changelog) {
  if (!lines[at].trim()) return -1;
  const startsBlock = line => !line.trim() || /^(?:#|[-*] )/.test(line);
  let first = at, last = at;
  while (first > 0 && !startsBlock(lines[first]) && lines[first - 1].trim() && !lines[first - 1].startsWith('#')) first--;
  while (last + 1 < lines.length && !startsBlock(lines[last + 1])) last++;
  return narrativeText(lines.slice(first, last + 1), changelog) ? last : -1;
}

// Headings, fences and HTML can start far above a changed paragraph. Read context from each immutable blob.
function changedProse(root, oid, ranges, changelog, link) {
  const lines = ranges.some(([, count]) => count) ? git(root, ['cat-file', 'blob', oid]).stdout.split(/\r?\n/) : [];
  if (link) lines[ranges[0][0] - 1] = lines[ranges[0][0] - 1].replace(link[0], link[1]);
  const headings = [];
  let fence = null, htmlEnd = null;
  const frontMatter = /^(?:---|\+\+\+)$/.test(lines[0]);
  const headerEnd = frontMatter ? lines.indexOf(lines[0], 1) : -1;
  if (frontMatter && headerEnd < 0) return null;
  let scanned = headerEnd + 1, paragraphStart = scanned, checkedThrough = -1;
  const pieces = [];
  for (const [start, count] of ranges) {
    pieces.push(lines.slice(start - 1, start - 1 + count).join('\n'));
    if (!count) continue;
    if (start <= headerEnd + 1 || start - 1 + count > lines.length) return null;
    for (; scanned < start - 1 + count; scanned++) {
      const line = lines[scanned], trimmed = line.trim();
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      // A closed HTML heading still governs later paragraphs. Leave its scope to a reviewer.
      if (!fence && /<\/?h[1-6]\b/i.test(line)) return null;
      const protectedLine = Boolean(fence || htmlEnd || marker || trimmed.startsWith('<'));
      if (protectedLine || !trimmed) paragraphStart = scanned + 1;
      if (htmlEnd) {
        if (trimmed.toLowerCase().includes(htmlEnd)) htmlEnd = null;
      } else if (fence) {
        if (marker?.[1].startsWith(fence) && /^[ \t]*$/.test(marker[2])) fence = null;
      } else if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = marker[1];
      else if (trimmed.startsWith('<')) {
        const tag = /^<([\w-]+)\b/.exec(trimmed.toLowerCase())?.[1];
        if (trimmed.startsWith('<!--')) htmlEnd = '-->';
        else if (tag && !trimmed.endsWith('/>') && !/^(?:br|hr|img|source|meta|link|input)$/.test(tag)) htmlEnd = `</${tag}>`;
        if (htmlEnd && trimmed.toLowerCase().includes(htmlEnd)) htmlEnd = null;
      } else {
        const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
        const underline = setextUnderline.exec(line);
        if (heading || (underline && paragraphStart < scanned)) {
          const title = heading ? [heading[2] || ''] : lines.slice(paragraphStart, scanned);
          if (!heading && title.some(part => !/^ {0,3}[\p{L}\p{N}]/u.test(part))) return null;
          headings.length = heading ? heading[1].length : (underline[1][0] === '=' ? 1 : 2);
          headings[headings.length - 1] = title.join(' ');
        }
        if (heading || underline) paragraphStart = scanned + 1;
      }
      if (scanned < start - 1) continue;
      if (protectedLine || headings.some(operativeText)) return null;
      if (scanned > checkedThrough && !(changelog && (!trimmed || line === '# Changelog'))) {
        checkedThrough = plainParagraphEnd(lines, scanned, changelog);
        if (checkedThrough < scanned) return null;
      }
    }
  }
  return pieces;
}

export function amendmentFiles(root, trees) {
  const entries = git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--ignore-submodules=none', ...trees, '--']).stdout.split('\0');
  const files = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const [oldMode, newMode, before, after, status] = entries[i].slice(1).split(' ');
    files.push({ path: entries[i + 1], oldMode, newMode, before, after, status });
  }
  return files;
}

// A target-only README correction must resolve the exact local document named in a fixed advisory.
function reviewedReadmeLink(root, tree, file, diff, hunks, findings) {
  if (!/^readme\.md$/i.test(file.path) || hunks.length !== 1 || !findings.length) return null;
  const [, line, oldCount, , newCount] = hunks[0];
  if (Number(oldCount ?? 1) !== 1 || Number(newCount ?? 1) !== 1) return null;
  const change = /^@@ [^\n]+\n-([^\n]+)\n\+([^\n]+)$/m.exec(diff);
  if (!change) return null;
  const localLink = /\[([\w -]+)\]\((docs\/(?:[\w-]+\/)*[\w-]+\.md)\)/;
  const old = localLink.exec(change[1]), next = localLink.exec(change[2]);
  if (!old || !next || old[1] !== next[1] || change[1].replace(old[0], next[0]) !== change[2]) return null;
  const finding = findings.find(({ finalAdvice: f }) => {
    if (!f || f.file !== file.path || f.line_start !== Number(line) || f.line_end !== Number(line) || typeof f.recommendation !== 'string') return false;
    const words = f.recommendation.split(/[\s`'"()[\]<>]+/).map(word => word.replace(/[.,;:!?]+$/, ''));
    const targets = new Set(words.filter(word => /\.\w/.test(word)));
    targets.delete(old[2]);
    return targets.size === 1 && targets.has(next[2]);
  });
  if (!finding || !editorialPath(next[2])) return null;
  const listing = name => git(root, ['ls-tree', tree, '--', name]).stdout;
  if (listing(old[2]) || !listing(next[2]).startsWith('100644 blob ')) return null;
  const target = git(root, ['cat-file', 'blob', `${tree}:${next[2]}`]).stdout;
  const narrative = target.split(/\r?\n[ \t]*\r?\n/).every(paragraph => {
    return !operativeText(paragraph.replace(/\s+/g, ' ')) && paragraph.split(/\r?\n/)
      .every(line => !line || narrativeText([line.replace(/^#{1,6} /, '')]));
  });
  if (!target.trim() || !narrative) return null;
  return { old, next, finding };
}

export function editorialReason(root, trees, file, rationale, linkFindings) {
  const changelog = /^changelog\.md$/i.test(file.path);
  if (!editorialPath(file.path)) return null;
  if (file.newMode !== '100644' || !(file.oldMode === '100644' && file.status === 'M' || changelog && file.status === 'A')) return null;
  const diff = git(root, ['diff', '--no-color', '--no-textconv', '--no-ext-diff', '--no-renames', '--unified=0', ...trees, '--', file.path]).stdout;
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  if (!hunks.length || scanDiffForSecrets(diff).length) return null;
  const ranges = offset => hunks.map(h => [Number(h[offset]), Number(h[offset + 1] ?? 1)]);
  const link = reviewedReadmeLink(root, trees[0], file, diff, hunks, linkFindings);
  const before = changedProse(root, file.before, ranges(1), changelog, link?.old);
  const after = changedProse(root, file.after, ranges(3), changelog, link?.next);
  if (!before || !after) return null;
  if (link) return `Fixed ${link.finding.id}: ${file.path} now links to ${link.next[2]}`;
  const entries = after.join('\n').split('\n').filter(line => line && line !== '# Changelog');
  if (changelog && before.every(old => !old) && entries.length && entries.every(line => releaseNote.test(line))) return `Changelog entry in ${file.path}`;
  if (rationale && before.every((old, i) => old && after[i])) return `Wording in ${file.path}: ${rationale}`;
  return null;
}
