// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack
// (ls-refs, fetch; protocol v2 and v0) and receive-pack. Operates on a Store.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import { type Repo, type Store } from './store.ts';

export const AGENT = 'forge/1.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** All refs of a repo, sorted by name: branches then tags. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** The annotated-tag target of a tag object, or null. */
function tagTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? (m[1] as string) : null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps =
    service === 'upload'
      ? `side-band-64k shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    // Empty repo: real git serves exactly one line — the capabilities ride on
    // the `capabilities^{}` pseudo-ref and there is no HEAD line. (A HEAD
    // line plus a bare capabilities^{} line makes real git fail with
    // "protocol error: unexpected capabilities^{}".)
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = defaultTip(repo);
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = tagTarget(repo, ref.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function infoRefs(repo: Repo | undefined, service: string, gitProtocol: string | undefined): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') return ok(UPLOAD_AD, v2Advertisement());
    return ok(UPLOAD_AD, v0Advertisement(repo, 'upload'));
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is always v0.
    return ok(RECEIVE_AD, v0Advertisement(repo, 'receive'));
  }
  return err(400, 'Invalid service');
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, lines: string[]): GitResponse {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  const headAttrs: string[] = [];
  if (args.symrefs) headAttrs.push(`symref-target:refs/heads/${repo.defaultBranch}`);
  if (tip === ZERO_OID) {
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${headAttrs.length > 0 ? ` ${headAttrs.join(' ')}` : ''}\n`));
    }
  } else if (keep('HEAD')) {
    parts.push(pktLine(`${tip} HEAD${headAttrs.length > 0 ? ` ${headAttrs.join(' ')}` : ''}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const attrs: string[] = [];
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = tagTarget(repo, ref.oid);
      if (peeled !== null) attrs.push(`peeled:${peeled}`);
    }
    parts.push(pktLine(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  parts.push(PKT_FLUSH);
  return ok(UPLOAD_RESULT, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// Fetch: send-set computation
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** The client sent `done`: negotiation is over, send the pack. */
  done: boolean;
}

interface SendSet {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch sends: the reachable closure of `wants`, minus the
 * closure of `haves`, cut at `depth` when given. `shallow` lists the new
 * boundary commits; `unshallow` lists client boundaries now fully included.
 */
export function computeSendSet(store: Store, repo: Repo, args: FetchArgs): SendSet {
  // Resolve wants to commits (following annotated tags) and record tag objects.
  const wantTags: GitObject[] = [];
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      wantTags.push(obj);
      const target = tagTarget(repo, want);
      if (target !== null) {
        const t = repo.objects.get(target);
        if (t !== undefined && t.type === 'commit') wantCommits.push(target);
      }
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
  }
  // BFS distances from the want commits (parents only).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const c of wantCommits) {
    if (!dist.has(c)) {
      dist.set(c, 0);
      queue.push(c);
    }
  }
  const depth = args.depth;
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    const d = dist.get(oid) as number;
    if (depth !== null && d + 1 >= depth) continue;
    const commit = store.commitOf(repo, oid);
    if (commit === null) continue;
    for (const p of commit.parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Haves closure (full depth, no limit) — but the traversal STOPS at a
  // client shallow boundary: the client holds that commit but not its
  // parents, so the parents are not held.
  const heldCommits = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldCommits.has(oid)) continue;
      const commit = store.commitOf(repo, oid);
      if (commit === null) continue;
      heldCommits.add(oid);
      if (args.shallow.includes(oid)) continue;
      for (const p of commit.parents) stack.push(p);
    }
  }
  // Held objects: each held commit plus its full tree (never its parents'
  // objects — those are not held past a shallow boundary).
  const heldObjs = new Set<string>();
  for (const c of heldCommits) {
    heldObjs.add(c);
    const commit = store.commitOf(repo, c);
    if (commit !== null) collectTreeObjects(repo, commit.tree, heldObjs);
  }
  // Included commits: in dist, not held.
  const included = new Set<string>();
  for (const [oid] of dist) {
    if (!heldCommits.has(oid)) included.add(oid);
  }
  // Commits the client will hold after this fetch (for boundary decisions).
  const present = new Set<string>([...heldCommits, ...included]);
  // New boundaries: included commits at the depth cut with at least one
  // parent the client still will not have.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (!included.has(oid) || d !== depth - 1) continue;
      const commit = store.commitOf(repo, oid);
      if (commit === null || commit.parents.length === 0) continue;
      if (commit.parents.some((p) => !present.has(p))) shallow.push(oid);
    }
  }
  // Unshallow: client boundaries whose parents the client will now all have.
  const unshallow: string[] = [];
  for (const b of args.shallow) {
    const commit = store.commitOf(repo, b);
    if (commit === null) continue;
    if (commit.parents.length === 0 || commit.parents.every((p) => present.has(p))) unshallow.push(b);
  }
  // Objects: included commits + their full trees, minus held objects. Tags
  // named by wants ride along when their target is included.
  const send = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    if (heldObjs.has(treeOid) || send.has(treeOid)) return;
    send.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else if (!heldObjs.has(e.oid) && !send.has(e.oid)) {
        const blob = repo.objects.get(e.oid);
        if (blob !== undefined) send.set(e.oid, blob);
      }
    }
  };
  for (const oid of included) {
    if (heldObjs.has(oid) || send.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    send.set(oid, obj);
    const commit = store.commitOf(repo, oid);
    if (commit !== null) addTree(commit.tree);
  }
  for (const tag of wantTags) {
    const oid = hashObject('tag', tag.data);
    if (!heldObjs.has(oid) && !send.has(oid)) send.set(oid, tag);
  }
  shallow.sort();
  unshallow.sort();
  return { objects: [...send.values()], shallow, unshallow };
}

/** Every object id in a tree's closure (the tree, its subtrees, its blobs). */
function collectTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') continue;
    out.add(cur);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else out.add(e.oid);
    }
  }
}

/** Chunk a pack into sideband band-1 pkt-lines (each <= 65516 payload bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // A pack is never empty (even 0 objects is 32 bytes), but stay safe.
    parts.push(pktLine(Buffer.from([1])));
  }
  return parts;
}

function fetchV2Response(store: Store, repo: Repo, args: FetchArgs): GitResponse {
  // Acknowledgments (only when the client negotiated with haves), in the
  // exact shape real git servers use: bare `ACK <oid>` lines for every
  // common have, then a separate `ready` line when negotiation is complete.
  // `ready` is what licenses the packfile in the same response; a NAK with
  // no `ready` means "send more haves or `done`" — sending the packfile
  // then makes real git die with "expected no other sections to be sent
  // after no 'ready'".
  const common: string[] =
    args.haves.length > 0
      ? args.haves.filter((have) => args.wants.some((want) => store.isAncestor(repo, have, want)))
      : [];
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (common.length === 0 && !args.done) {
      // No common base and negotiation still open: ack section only.
      parts.push(PKT_FLUSH);
      return ok(UPLOAD_RESULT, Buffer.concat(parts));
    }
  }
  const send = computeSendSet(store, repo, args);
  const pack = writePack(send.objects);
  if (send.shallow.length > 0 || send.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of send.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of send.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return ok(UPLOAD_RESULT, Buffer.concat(parts));
}

function fetchV0Response(store: Store, repo: Repo, args: FetchArgs): GitResponse {
  const send = computeSendSet(store, repo, args);
  const pack = writePack(send.objects);
  // ACK every common have (reachable from a want); NAK only when none is
  // common. Shape matches real git servers (multi_ack_detailed): each
  // common have gets `ACK <oid> common`, then a final bare `ACK <last>`
  // signals negotiation is done and the pack follows. A bare ACK up front
  // makes real git expect the pack at once and die with "bad band" on the
  // next ACK line; always NAKing makes it warn "no common commits".
  const common = args.haves.filter((have) => args.wants.some((want) => store.isAncestor(repo, have, want)));
  const parts: Buffer[] = [];
  if (common.length > 0) {
    for (const oid of common) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine(`ACK ${common[common.length - 1] as string}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of send.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of send.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return ok(UPLOAD_RESULT, Buffer.concat(parts));
}

/** Parse the command lines of an upload-pack request (v0 or v2). */
function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (/^[0-9a-f]{40}$/.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (/^[0-9a-f]{40}$/.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0] as string;
      if (/^[0-9a-f]{40}$/.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    } else if (line === 'done') {
      args.done = true;
    }
    // thin-pack, no-progress, ofs-delta, agent=, object-format=, filter: ignored.
  }
  return args;
}

export function uploadPack(store: Store, repo: Repo | undefined, body: Buffer, gitProtocol: string | undefined): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  let pkts: Pkt[];
  try {
    pkts = decodePktLines(body);
  } catch {
    return err(400, 'Bad request');
  }
  const lines: string[] = [];
  for (const p of pkts) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) return err(400, 'Bad request');
  const first = lines[0] as string;
  if (gitProtocol === 'version=2') {
    if (first === 'command=ls-refs') return handleLsRefs(repo, lines.slice(1));
    if (first === 'command=fetch') {
      // Lines after the command (agent=, object-format=) are ignored by the
      // fetch parser; only want/have/shallow/deepen lines matter.
      return fetchV2Response(store, repo, parseFetchLines(lines.slice(1)));
    }
    return err(400, 'Bad request');
  }
  // v0: want/have/shallow/deepen lines in either section.
  return fetchV0Response(store, repo, parseFetchLines(lines));
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function reportResponse(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail: string): GitResponse {
  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const r of results) {
    inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let off = 0; off < innerBytes.length; off += CHUNK) {
    const slice = innerBytes.subarray(off, Math.min(innerBytes.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return ok(RECEIVE_RESULT, Buffer.concat(parts));
}

export function receivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  // Walk pkt-lines until the first flush; everything after it is the pack.
  // (The pack bytes are NOT pkt-lines, so the whole body must not be decoded
  // as pkt-lines.)
  let head: Pkt[];
  let packBytes: Buffer;
  try {
    const split = splitCommands(body);
    head = split.head;
    packBytes = split.rest;
  } catch {
    return err(400, 'Bad request');
  }
  const commands: PushCommand[] = [];
  for (const p of head) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m === null) return err(400, 'Bad request');
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  if (commands.length === 0) return err(400, 'Bad request');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpacked: Map<string, GitObject> | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      return reportResponse(
        commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack error' })),
        false,
        'error unpack failed: empty pack',
      );
    }
    try {
      const sum = verifyPackChecksum(packBytes);
      if (!sum.ok) throw new Error('pack: bad trailer checksum');
      unpacked = readPack(packBytes, (oid) => repo.objects.get(oid)).objects;
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unpack failed';
      return reportResponse(
        commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack error' })),
        false,
        `error ${detail}`,
      );
    }
    store.putObjects(repo, unpacked.values());
  }
  // Validate and apply each command in order; only the ok ones apply.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid command' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (unpacked !== null && !unpacked.has(cmd.newOid) && repo.objects.get(cmd.newOid) === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return reportResponse(results, true, 'ok');
}

/**
 * Parse pkt-lines from the start of `buf` until the first flush packet.
 * Returns the packets before it and the bytes after it (the pack). Throws on
 * a malformed prefix or when no flush appears.
 */
function splitCommands(buf: Buffer): { head: Pkt[]; rest: Buffer } {
  const head: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('pkt-line: truncated length prefix');
    const prefix = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new Error('pkt-line: bad length prefix');
    const len = parseInt(prefix, 16);
    if (len === 0) return { head, rest: buf.subarray(pos + 4) };
    if (len === 1) {
      head.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      head.push({ kind: 'end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || len > 65520) throw new Error('pkt-line: bad length');
    if (pos + len > buf.length) throw new Error('pkt-line: truncated packet');
    head.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  throw new Error('pkt-line: no flush');
}
