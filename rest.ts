// rest.ts — GitHub REST v3 surface. Handlers take a Store and a parsed request
// and answer with {status, body} (body already JSON-stringified by the caller
// via sendJson, or a raw Buffer for binary). All bodies are plain JSON.

import { hashObject, parseTree } from './gitcore.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentGlobalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  host: string;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(): RestResult {
  return err(404, 'Not Found');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Query int with a default and clamp. */
function qint(q: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const ts = store.isoTs(1_700_000_000 + repo.createdSeq);
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ts,
    updated_at: ts,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelJson(label ?? { name, color: 'ededed' });
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: store.isoTs(1_700_000_000 + issue.seq),
    updated_at: store.isoTs(1_700_000_000 + issue.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string; user: string }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number * 1000 + comment.id,
    node_id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: comment.user, id: comment.user === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: store.isoTs(1_700_000_000 + comment.id),
    updated_at: store.isoTs(1_700_000_000 + comment.id),
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner, id: VIEWER_ID } },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner, id: VIEWER_ID } },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: store.isoTs(1_700_000_000 + pull.seq),
    updated_at: store.isoTs(1_700_000_000 + pull.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  return repo ?? null;
}

/** Paginate an array; returns {page, headers} with a Link header when needed. */
function paginate<T>(items: readonly T[], q: URLSearchParams, req: Req, basePath: string): { page: T[]; headers: Record<string, string> } {
  const perPage = qint(q, 'per_page', 30, 1, 100);
  const pageNum = qint(q, 'page', 1, 1, 1_000_000);
  const total = items.length;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const origin = `http://${req.host}`;
  const link = (page: number, rel: string): string => `<${origin}${basePath}?per_page=${perPage}&page=${page}>; rel="${rel}"`;
  const parts: string[] = [];
  if (pageNum < lastPage) parts.push(link(pageNum + 1, 'next'), link(lastPage, 'last'));
  if (pageNum > 1) parts.push(link(1, 'first'), link(pageNum - 1, 'prev'));
  if (parts.length > 0) headers.link = parts.join(', ');
  return { page, headers };
}

function sortIssues(issues: Issue[], q: URLSearchParams): Issue[] {
  const dir = (q.get('direction') ?? 'desc').toLowerCase();
  const sorted = [...issues].sort((a, b) => a.seq - b.seq);
  return dir === 'asc' ? sorted : sorted.reverse();
}

function filterIssues(issues: Issue[], q: URLSearchParams): Issue[] {
  const state = (q.get('state') ?? 'open').toLowerCase();
  if (state === 'all') return issues;
  if (state === 'closed') return issues.filter((i) => i.state === 'closed');
  return issues.filter((i) => i.state === 'open');
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(store: Store, req: Req): RestResult | null {
  const { method, path, query: q } = req;
  if (!path.startsWith('/api/v3')) return null;
  const rest = path.slice('/api/v3'.length);

  // API root and meta (root takes no auth; meta is an API call, handled by
  // the caller — auth is checked in app.ts before this runs, except root).
  if (method === 'GET' && (rest === '' || rest === '/')) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && rest === '/meta') {
    return ok(200, { installed_version: '1.0.0' });
  }

  // /user
  if (rest === '/user') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: 'U_1000',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    });
  }

  // /user/repos
  if (rest === '/user/repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const { page, headers } = paginate(repos, q, req, '/api/v3/user/repos');
      return ok(200, page.map((r) => repoJson(store, r)), headers);
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const name = asString(req.body.name);
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Invalid repository name');
      const created = store.createRepo(name, asBool(req.body.private, false), asString(req.body.description));
      if (created === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(store, created));
    }
    return err(405, 'Method Not Allowed');
  }

  // /repos/{owner}/{repo}[...]
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
  if (m === null) return null;
  const owner = decodeURIComponent(m[1] as string);
  const repoName = decodeURIComponent(m[2] as string);
  const tail = m[3] ?? '';
  const repo = resolveRepo(store, owner, repoName);

  // Repo object itself.
  if (tail === '') {
    if (repo === null) return notFound();
    if (method === 'GET') return ok(200, repoJson(store, repo));
    if (method === 'PATCH') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      if (typeof req.body.description === 'string') repo.description = req.body.description;
      if (typeof req.body.private === 'boolean') repo.private = req.body.private;
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return err(405, 'Method Not Allowed');
  }

  if (repo === null) return notFound();
  const segs = tail.split('/').filter((s) => s !== '');

  // /branches
  if (segs[0] === 'branches') {
    if (segs.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string } }));
      return ok(200, list);
    }
    if (segs.length === 2 && method === 'GET') {
      const name = decodeURIComponent(segs[1] as string);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return notFound();
      return ok(200, { name, commit: { sha } });
    }
    return err(405, 'Method Not Allowed');
  }

  // /commits
  if (segs[0] === 'commits' && segs.length === 1 && method === 'GET') {
    const refName = q.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${refName}`) ?? (refName.length === 40 ? refName : undefined);
    if (tip === undefined || repo.objects.get(tip)?.type !== 'commit') return ok(200, []);
    const perPage = qint(q, 'per_page', 30, 1, 100);
    const list = store.commitList(repo, tip).slice(0, perPage);
    return ok(
      200,
      list.map((sha) => {
        const c = store.commitOf(repo, sha);
        const msg = (c?.message ?? '').replace(/\n+$/, '');
        return {
          sha,
          commit: {
            message: msg,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.isoTs(1_700_000_000) },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.isoTs(1_700_000_000) },
          },
          parents: (c?.parents ?? []).map((p) => ({ sha: p })),
        };
      }),
    );
  }

  // /git/refs
  if (segs[0] === 'git' && segs[1] === 'refs') {
    if (method === 'POST' && segs.length === 2) {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const ref = asString(req.body.ref);
      const sha = asString(req.body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.objects.get(sha) === undefined) return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && segs.length >= 3) {
      const ref = `refs/${segs.slice(2).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return ok(200, { ref, object: { sha } });
    }
    return err(405, 'Method Not Allowed');
  }

  // /contents/...
  if (segs[0] === 'contents') {
    return handleContents(store, repo, req, segs.slice(1));
  }

  // /labels
  if (segs[0] === 'labels') {
    if (method === 'GET' && segs.length === 1) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'POST' && segs.length === 1) {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const name = asString(req.body.name);
      const color = asString(req.body.color, 'ededed');
      if (name === '') return err(422, 'Invalid label name');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label: Label = { name, color };
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    return err(405, 'Method Not Allowed');
  }

  // /issues[/{n}[/comments]]
  if (segs[0] === 'issues') {
    return handleIssues(store, repo, req, segs.slice(1));
  }

  // /pulls[/{n}[/files|merge]]
  if (segs[0] === 'pulls') {
    return handlePulls(store, repo, req, segs.slice(1));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contentPath(segs: readonly string[]): string {
  return segs.map((s) => decodeURIComponent(s)).join('/');
}

function handleContents(store: Store, repo: Repo, req: Req, segs: readonly string[]): RestResult {
  const { method, query: q } = req;
  const path = contentPath(segs);
  const branch = q.get('ref') ?? (isRecord(req.body) ? asString(req.body.branch, '') : '') ?? '';
  const refName = branch === '' ? repo.defaultBranch : branch;
  const tip = repo.refs.get(`refs/heads/${refName}`);

  if (method === 'GET') {
    if (tip === undefined) return notFound();
    const flat = store.treeMapOfCommit(repo, tip);
    if (flat === null) return notFound();
    if (path === '') {
      // Root listing.
      return ok(200, dirEntries(store, repo, tip, ''));
    }
    const file = flat.get(path);
    if (file !== undefined) {
      const obj = repo.objects.get(file.oid);
      if (obj === undefined || obj.type !== 'blob') return notFound();
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: obj.data.length,
        content: obj.data.toString('base64'),
      });
    }
    // Directory?
    const prefix = `${path}/`;
    let isDir = false;
    for (const key of flat.keys()) if (key.startsWith(prefix)) { isDir = true; break; }
    if (!isDir) return notFound();
    return ok(200, dirEntries(store, repo, tip, path));
  }

  if (method === 'PUT') {
    if (!isRecord(req.body)) return err(400, 'Bad request');
    const message = asString(req.body.message);
    const contentB64 = asString(req.body.content);
    if (message === '' || contentB64 === '') return err(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const bodyBranch = asString(req.body.branch, '');
    const targetBranch = bodyBranch === '' ? repo.defaultBranch : bodyBranch;
    const targetRef = `refs/heads/${targetBranch}`;
    const targetTip = repo.refs.get(targetRef);
    const existingSha = targetTip === undefined ? undefined : store.treeMapOfCommit(repo, targetTip)?.get(path)?.oid;
    const givenSha = asString(req.body.sha, '');
    if (existingSha !== undefined) {
      if (givenSha === '' || givenSha !== existingSha) return err(409, 'sha does not match the current file');
    }
    const blobSha = hashObject('blob', content);
    const written = store.commitFile(repo, targetBranch, path, content, message);
    if (written === null) return err(422, 'could not write the file');
    const status = existingSha !== undefined ? 200 : 201;
    return ok(status, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: written.commitSha, message },
    });
  }

  if (method === 'DELETE') {
    if (!isRecord(req.body)) return err(400, 'Bad request');
    const message = asString(req.body.message, `Delete ${path}`);
    const givenSha = asString(req.body.sha, '');
    const targetBranch = asString(req.body.branch, '') || repo.defaultBranch;
    const targetTip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (targetTip === undefined) return notFound();
    const existingSha = store.treeMapOfCommit(repo, targetTip)?.get(path)?.oid;
    if (existingSha === undefined) return notFound();
    if (givenSha !== '' && givenSha !== existingSha) return err(409, 'sha does not match the current file');
    const sha = store.deleteFile(repo, targetBranch, path, message);
    if (sha === null) return notFound();
    return ok(200, { commit: { sha, message } });
  }

  return err(405, 'Method Not Allowed');
}

function dirEntries(store: Store, repo: Repo, tip: string, dir: string): Array<Record<string, unknown>> {
  const flat = store.treeMapOfCommit(repo, tip);
  if (flat === null) return [];
  const prefix = dir === '' ? '' : `${dir}/`;
  const files = new Map<string, { oid: string; mode: string }>();
  const dirs = new Map<string, string>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) files.set(rest, file);
    else dirs.set(rest.slice(0, slash), '');
  }
  // Directory shas come from the tree objects.
  const out: Array<Record<string, unknown>> = [];
  const dirTreeOid = (d: string): string => {
    // Walk the tree to the directory.
    let cur = store.commitOf(repo, tip)?.tree;
    if (cur === undefined) return '';
    if (d === '') return cur;
    for (const part of d.split('/')) {
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'tree') return '';
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (entry === undefined) return '';
      cur = entry.oid;
    }
    return cur;
  };
  for (const name of [...dirs.keys()].sort()) {
    out.push({ type: 'dir', name, path: prefix + name, sha: dirTreeOid(prefix + name) });
  }
  for (const name of [...files.keys()].sort()) {
    const file = files.get(name) as { oid: string; mode: string };
    const obj = repo.objects.get(file.oid);
    out.push({ type: 'file', name, path: prefix + name, sha: file.oid, size: obj?.data.length ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(store: Store, repo: Repo, req: Req, segs: readonly string[]): RestResult {
  const { method, query: q } = req;

  if (segs.length === 0) {
    if (method === 'GET') {
      const list = sortIssues(filterIssues([...repo.issues.values()], q), q);
      const { page, headers } = paginate(list, q, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return ok(200, page.map((i) => issueJson(store, repo, i)), headers);
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const title = asString(req.body.title);
      if (title === '') return err(422, 'title is required');
      const body = asString(req.body.body, '');
      const labels: string[] = Array.isArray(req.body.labels) ? req.body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = { number, title, body, state: 'open', labels, comments: [], seq: number };
      repo.issues.set(number, issue);
      return ok(201, issueJson(store, repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }

  const number = Number(segs[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();

  if (segs.length === 1) {
    if (method === 'GET') return ok(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      if (typeof req.body.state === 'string' && (req.body.state === 'open' || req.body.state === 'closed')) issue.state = req.body.state;
      if (typeof req.body.title === 'string') issue.title = req.body.title;
      if (typeof req.body.body === 'string') issue.body = req.body.body;
      return ok(200, issueJson(store, repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }

  if (segs.length === 2 && segs[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((c) => commentJson(store, repo, issue, c)));
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const body = asString(req.body.body);
      if (body === '') return err(422, 'body is required');
      const comment = { id: repo.nextCommentId, body, user: VIEWER_LOGIN };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return ok(201, commentJson(store, repo, issue, comment));
    }
    return err(405, 'Method Not Allowed');
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(store: Store, repo: Repo, req: Req, segs: readonly string[]): RestResult {
  const { method, query: q } = req;

  if (segs.length === 0) {
    if (method === 'GET') {
      const state = (q.get('state') ?? 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.seq - b.seq);
      const { page, headers } = paginate(list, q, req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return ok(200, page.map((p) => pullJson(store, repo, p)), headers);
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(400, 'Bad request');
      const head = asString(req.body.head);
      const base = asString(req.body.base);
      const title = asString(req.body.title);
      if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return err(422, 'A pull request already exists for this head and base');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: Pull = {
        number,
        title,
        body: asString(req.body.body, ''),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return ok(201, pullJson(store, repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }

  const number = Number(segs[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (segs.length === 1) {
    if (method === 'GET') return ok(200, pullJson(store, repo, pull));
    return err(405, 'Method Not Allowed');
  }

  if (segs.length === 2 && segs[1] === 'files' && method === 'GET') {
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    return ok(200, store.diffFiles(repo, baseSha, headSha));
  }

  if (segs.length === 2 && segs[1] === 'merge' && method === 'PUT') {
    if (pull.state === 'closed') return err(405, 'Pull request is already closed');
    const methodName = isRecord(req.body) ? asString(req.body.merge_method, 'squash') : 'squash';
    if (methodName !== 'squash' && methodName !== 'merge' && methodName !== 'rebase') return err(422, 'Invalid merge method');
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return err(405, 'Merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    const { ts } = store.nextIdentity();
    pull.mergedAt = store.isoTs(ts);
    return ok(200, { merged: true, sha, message: `${pull.title} (#${pull.number})` });
  }

  return notFound();
}

export { parseGlobalId };
