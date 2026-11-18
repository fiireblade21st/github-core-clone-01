// store.ts — the forge's in-memory state: repositories, git objects, refs,
// issues, pull requests, labels. Deterministic: commit timestamps come from a
// fixed epoch plus a counter, never the wall clock.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fixed epoch for every timestamp the forge invents (scenario-epoch based). */
export const BASE_TS = 1_700_000_000;

export interface IssueComment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return `P_${repo.id}_${pull.number}`;
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return `C_${repo.id}_${issue.number}_${comment.id}`;
}

/** Parse a global id back into {kind, repoId, number?, commentId?}. */
export function parseGlobalId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
  const parts = id.split('_');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId) || repoId <= 0) return null;
  const number = parts.length >= 3 ? Number(parts[2]) : 0;
  const commentId = parts.length >= 4 ? Number(parts[3]) : 0;
  if ((kind === 'I' || kind === 'P') && (!Number.isInteger(number) || number <= 0)) return null;
  return { kind, repoId, number, commentId };
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  repoSeq = 0;
  commitSeq = 0;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(repoKey(VIEWER_LOGIN, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.repos.set(repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  /** A deterministic author/committer line for commits the forge invents. */
  nextIdentity(): { line: string; ts: number } {
    const ts = BASE_TS + this.commitSeq;
    this.commitSeq += 1;
    return { line: `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`, ts };
  }

  isoTs(ts: number): string {
    return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const obj of objects) {
      const oid = hashObject(obj.type, obj.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  /** The commit object at `oid`, parsed, or null. */
  commitOf(repo: Repo, oid: string): ReturnType<typeof parseCommit> | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Flatten a commit's tree into path -> {oid, mode}. */
  treeFlat(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.treeFlat(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }

  treeMapOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> | null {
    const commit = this.commitOf(repo, commitOid);
    if (commit === null) return null;
    const out = new Map<string, { oid: string; mode: string }>();
    this.treeFlat(repo, commit.tree, '', out);
    return out;
  }

  /** Build a tree object from a flat path map (nested dirs created as needed). */
  buildTreeFromMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a commit object with a deterministic timestamp. Returns its oid. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const { line } = this.nextIdentity();
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({ tree: treeOid, parents, author: line, committer: line, message: msg });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Write one file on `branch` (creating the branch from the default tip when
   * it does not exist yet). Returns {commitSha, blobSha} or null when the
   * branch cannot be resolved and the repo has no default tip.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } | null {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      if (branch === repo.defaultBranch) tip = undefined;
      else tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined && repo.refs.size > 0) return null;
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const flat = tip === undefined ? new Map() : this.treeMapOfCommit(repo, tip) ?? new Map();
    flat.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTreeFromMap(repo, flat);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete one file on `branch`. Returns the new commit sha or null. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const flat = this.treeMapOfCommit(repo, tip);
    if (flat === null || !flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTreeFromMap(repo, flat);
    const commitSha = this.makeCommit(repo, treeOid, [tip], message);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  // -- reachability ----------------------------------------------------------

  /** All ancestors of `tip` (inclusive), newest-first walk order not guaranteed. */
  commitClosure(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      for (const p of commit.parents) stack.push(p);
    }
    return seen;
  }

  /** True when `anc` is reachable from `desc` (or equal). Early-exit walk: a
   * fast-forward push resolves in one or two steps instead of parsing the
   * whole history. */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === anc) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const p of commit.parents) stack.push(p);
    }
    return false;
  }

  /** Newest-first list of commits reachable from `tip`. */
  commitList(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      order.push(oid);
      // Parents pushed in order so the first parent pops first (newest first
      // along the first-parent chain; merges interleave, which is fine).
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return order;
  }

  /** The merge-base of two commits (nearest common ancestor), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = this.commitClosure(repo, a);
    if (aSet.has(b)) return b;
    // BFS from b: the first commit also in aSet is the nearest common ancestor.
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aSet.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const p of commit.parents) queue.push(p);
    }
    return null;
  }

  // -- diff / merge ----------------------------------------------------------

  diffFiles(
    repo: Repo,
    baseCommit: string,
    headCommit: string,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = this.treeMapOfCommit(repo, baseCommit) ?? new Map();
    const head = this.treeMapOfCommit(repo, headCommit) ?? new Map();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      let status = 'modified';
      let oldText = '';
      let newText = '';
      if (b === undefined) {
        status = 'added';
        const obj = repo.objects.get((h as { oid: string }).oid);
        newText = obj?.type === 'blob' ? obj.data.toString('utf8') : '';
      } else if (h === undefined) {
        status = 'removed';
        const obj = repo.objects.get(b.oid);
        oldText = obj?.type === 'blob' ? obj.data.toString('utf8') : '';
      } else {
        const bo = repo.objects.get(b.oid);
        const ho = repo.objects.get(h.oid);
        oldText = bo?.type === 'blob' ? bo.data.toString('utf8') : '';
        newText = ho?.type === 'blob' ? ho.data.toString('utf8') : '';
      }
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /**
   * Three-way conflict test: a file changed head-vs-merge-base conflicts when
   * the base tip's version differs from both the merge-base and head versions.
   */
  hasConflict(repo: Repo, baseTip: string, headTip: string): boolean {
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    if (mergeBase === null) return true;
    const baseMap = this.treeMapOfCommit(repo, mergeBase) ?? new Map();
    const headMap = this.treeMapOfCommit(repo, headTip) ?? new Map();
    const tipMap = this.treeMapOfCommit(repo, baseTip) ?? new Map();
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path)?.oid;
      const h = headMap.get(path)?.oid;
      if (b === h) continue;
      const t = tipMap.get(path)?.oid;
      if (t !== b && t !== h) return true;
    }
    return false;
  }

  /** Mergeable state for a pull request: MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeableState(repo: Repo, pull: Pull): string {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    if (pull.state === 'closed') return 'UNKNOWN';
    return this.hasConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is
   * the head tip's tree. Returns the merge commit sha, or null on conflict.
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseRef = `refs/heads/${pull.base}`;
    const headRef = `refs/heads/${pull.head}`;
    const baseTip = repo.refs.get(baseRef);
    const headTip = repo.refs.get(headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    if (this.hasConflict(repo, baseTip, headTip)) return null;
    const headCommit = this.commitOf(repo, headTip);
    if (headCommit === null) return null;
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.makeCommit(repo, headCommit.tree, [baseTip], message);
    repo.refs.set(baseRef, sha);
    return sha;
  }
}

/** Multiset line diff: lines in new not in old are additions, vice versa. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

/** A commit's message, or '' when the object is not a commit. */
export function commitMessageOf(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

export { ZERO_OID };
