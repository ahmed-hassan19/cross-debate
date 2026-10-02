// Everything that talks to GitHub (gh): identify the PR, read it, post the review.
import { run, text, json } from './shell.mjs';

// ---------- identify the target ----------

/** Turn a PR URL or a bare number (+ git origin) into { host, origin, owner, repo, number }. */
export function parseTarget(target, originUrl) {
  const github = target.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/);
  if (github) {
    const t = { host: 'github', origin: github[1].toLowerCase(), owner: github[2], repo: github[3], number: Number(github[4]) };
    requireGithub(t.origin);
    return t;
  }

  if (/^\d+$/.test(target)) {
    if (!originUrl) throw new Error('a bare PR number needs a git remote to resolve against');
    const origin = parseOrigin(originUrl);
    if (!origin) throw new Error(`cannot parse git origin: ${originUrl}`);
    requireGithub(origin.origin);
    return { ...origin, number: Number(target) };
  }

  throw new Error(`unrecognised target: ${target} (only GitHub pull request URLs or numbers are supported)`);
}

/** Parse a git remote URL (https or ssh) into { host, origin, owner, repo }. */
export function parseOrigin(url) {
  const m = url.match(/^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)
    || url.match(/^(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const origin = m[1].toLowerCase();
  const segments = m[2].split('/');
  return { host: 'github', origin, owner: segments.slice(0, -1).join('/'), repo: segments.at(-1) };
}

const hostCache = new Map();

/**
 * A GitHub Enterprise host can be named anything, so ask gh whether it is logged in there rather
 * than matching on the name; that is also the check that decides whether the gh calls below can work.
 */
function requireGithub(origin) {
  if (origin === 'github.com') return;
  if (!hostCache.has(origin)) {
    let ok = false;
    try {
      ok = run('gh', ['auth', 'status', '--hostname', origin], { allowFail: true }).status === 0;
    } catch {
      ok = false; // gh not installed
    }
    hostCache.set(origin, ok);
  }
  if (!hostCache.get(origin)) {
    throw new Error(`unsupported forge ${origin}: only GitHub is supported (for GitHub Enterprise run gh auth login --hostname ${origin}); use --local to review a working tree`);
  }
}

export function projectPath(t) {
  return `${t.owner}/${t.repo}`;
}

/** The https URL to clone this repo from. */
export function cloneUrl(t) {
  return `https://${t.origin}/${projectPath(t)}.git`;
}

// GH_HOST points gh at the right instance; a no-op when the origin is github.com.
function ghEnv(t) {
  return { ...process.env, GH_HOST: t.origin };
}

// ---------- read the PR ----------

/** Fetch what we need about the PR: title, body, head/base shas, branch names, fetch ref. */
export function fetchPR(t) {
  const env = ghEnv(t);
  const pr = json('gh', ['pr', 'view', String(t.number), '--repo', projectPath(t),
    '--json', 'title,body,url,headRefOid,headRefName,baseRefName'], { env });
  const baseSha = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}`, '-q', '.base.sha'], { env });
  return {
    title: pr.title,
    body: pr.body || '',
    url: pr.url,
    head: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    baseSha,
    fetchRef: `pull/${t.number}/head`,
  };
}

/** True if a debate-review for this head sha is already on the PR. */
export function alreadyReviewed(t, pr) {
  const marker = `<!-- debate-review head=${pr.head}`;
  const bodies = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--paginate', '-q', '.[].body'], { env: ghEnv(t) });
  return bodies.includes(marker);
}

/** Collect up to two referenced issues (#123) as the Spec source. */
export function fetchSpec(t, pr, commitsText) {
  const haystack = `${pr.title}\n${pr.body}\n${commitsText}`;
  const numbers = [...new Set([...haystack.matchAll(/(?:^|[^\w/])#(\d+)\b/g)].map(m => m[1]))].slice(0, 2);

  const parts = [];
  for (const n of numbers) {
    try {
      const issue = json('gh', ['issue', 'view', n, '--repo', projectPath(t), '--json', 'title,body,url'], { env: ghEnv(t) });
      parts.push(`Issue #${n}: ${issue.title}\n${issue.url}\n${issue.body || ''}`);
    } catch {
      // "#12" was not an issue (PR number, plain text). skip it
    }
  }
  if (parts.length === 0) return 'none found, skip the Spec axis';
  return parts.join('\n\n---\n\n').slice(0, 8000);
}

// ---------- post the review ----------

/**
 * Post one review with inline comments. `comments` items: { path, line, start_line?, body }.
 * Event is always COMMENT. never approve/request-changes on the author's behalf.
 */
export function postReview(t, pr, body, comments) {
  const payload = {
    commit_id: pr.head,
    event: 'COMMENT',
    body,
    comments: comments.map(c => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
      ...(c.start_line ? { start_line: c.start_line, start_side: 'RIGHT' } : {}),
    })),
  };
  const review = json('gh', ['api', '--method', 'POST', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--input', '-'],
    { input: JSON.stringify(payload), env: ghEnv(t) });
  return { reviewId: review.id, url: review.html_url };
}
