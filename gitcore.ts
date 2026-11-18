// gitcore.ts — git object model, packfiles and pkt-lines. Pure functions, no I/O.
// Stdlib only (node:crypto, node:zlib). All object ids are lowercase hex SHA-1.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OID_RE = /^[0-9a-f]{40}$/;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The SHA-1 of a git object: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// Commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(c: CommitInfo): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const p of c.parents) out += `parent ${p}\n`;
  out += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(out, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree-entry sort: directory names compare as if they ended with '/'. */
export function treeSortKey(name: string, mode: string): string {
  return mode === '40000' ? `${name}/` : name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode);
    const kb = treeSortKey(b.name, b.mode);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const mode = data.toString('ascii', pos, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(t: TagInfo): Buffer {
  return Buffer.from(
    `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${t.tagger}\n\n${t.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = ZERO_OID;
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a whole pkt-line stream. Throws on a malformed length prefix, a short
 * packet or a length outside 0..65520. A trailing partial packet throws too.
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('pkt-line: truncated length prefix');
    const head = buf.toString('ascii', pos, pos + 4);
    if (!HEX4.test(head)) throw new Error('pkt-line: bad length prefix');
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || len > 65520) throw new Error('pkt-line: bad length');
    if (pos + len > buf.length) throw new Error('pkt-line: truncated packet');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles (plain objects only on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function encodePackHeader(type: ObjType | number, size: number): Buffer {
  // Git's varint: low 4 bits of size in the first byte, then 7-bit groups.
  const bytes: number[] = [];
  let b = ((typeof type === 'number' ? type : TYPE_CODE[type]) << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Write a version-2 pack of plain (non-delta) objects, in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(encodePackHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A 0-object pack: 12-byte header + 20-byte trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

/**
 * Adler-32 checksum (the trailer of every zlib stream). Pure JS, fast for
 * the small objects here.
 */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `offset`, whose decompressed size is
 * `expectedSize`. Returns the output and the offset just past the stream.
 *
 * inflateSync ignores trailing bytes, so the stream end is found without
 * probing: inflate once with a generous end, compute the Adler-32 of the
 * output (the last 4 bytes of any zlib stream), locate those 4 bytes in the
 * input, and verify with one exact-length inflate. This costs 2 inflateSync
 * calls per object instead of ~15 for a probe + binary search.
 */
function inflateOne(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  // Upper bound for the compressed size: incompressible data is at most
  // expectedSize + a small overhead; allow the whole rest of the buffer.
  const generousEnd = buf.length;
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(offset, generousEnd));
  } catch {
    throw new Error('pack: corrupt zlib stream');
  }
  if (data.length !== expectedSize) throw new Error('pack: corrupt zlib stream');
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  // The stream's Adler-32 trailer starts at its end minus 4.
  let searchFrom = offset + 2; // skip the 2-byte zlib header
  for (;;) {
    const at = buf.indexOf(adler, searchFrom);
    if (at < 0) throw new Error('pack: corrupt zlib stream');
    const end = at + 4;
    try {
      const check = inflateSync(buf.subarray(offset, end));
      if (check.length === expectedSize) return { data: check, next: end };
    } catch {
      // False-positive Adler match inside the deflate data; keep looking.
    }
    searchFrom = at + 1;
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('pack: truncated delta');
      const b = delta[pos] as number;
      pos += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return out;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('pack: delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('pack: truncated delta copy');
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('pack: truncated delta copy');
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('pack: delta copy out of range');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('pack: truncated delta insert');
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('pack: zero delta opcode');
    }
  }
  if (total !== resultSize) throw new Error('pack: delta result size mismatch');
  return Buffer.concat(parts, total);
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a version-2 pack. Resolves ofs-delta and ref-delta objects. `resolveBase`
 * supplies objects the pack references but does not carry (thin packs). Throws
 * on any malformed byte.
 */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (buf.length < 32) throw new Error('pack: too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack: bad magic');
  if (buf.readUInt32BE(4) !== 2) throw new Error('pack: bad version');
  const count = buf.readUInt32BE(8);
  const expectedTrailer = sha1Hex(buf.subarray(0, buf.length - 20));
  const actualTrailer = buf.subarray(buf.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack: bad trailer checksum');

  interface Raw {
    offset: number;
    code: number;
    size: number;
    dataOffset: number;
    /** Inflated payload, computed once in the first pass. */
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    if (pos >= buf.length - 20) throw new Error('pack: truncated entry');
    let b = buf[pos] as number;
    pos += 1;
    const code = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= buf.length - 20) throw new Error('pack: truncated size');
      b = buf[pos] as number;
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const raw: Raw = { offset: start, code, size, dataOffset: pos, data: Buffer.alloc(0) };
    if (code === 6) {
      // ofs-delta: negative offset varint.
      if (pos >= buf.length - 20) throw new Error('pack: truncated ofs-delta');
      b = buf[pos] as number;
      pos += 1;
      let off = b & 0x7f;
      while (b & 0x80) {
        if (pos >= buf.length - 20) throw new Error('pack: truncated ofs-delta');
        b = buf[pos] as number;
        pos += 1;
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      raw.baseOffset = start - off;
    } else if (code === 7) {
      if (pos + 20 > buf.length - 20) throw new Error('pack: truncated ref-delta');
      raw.baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!(code >= 1 && code <= 4)) {
      throw new Error(`pack: unknown object type ${code}`);
    }
    raw.dataOffset = pos;
    const inflated = inflateOne(buf, pos, size);
    raw.data = inflated.data;
    pos = inflated.next;
    raws.push(raw);
  }

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  const resolve = (raw: Raw, depth: number): GitObject => {
    if (depth > 64) throw new Error('pack: delta chain too deep');
    const cached = byOffset.get(raw.offset);
    if (cached !== undefined) return cached;
    const data = raw.data;
    let obj: GitObject;
    if (raw.code >= 1 && raw.code <= 4) {
      obj = { type: CODE_TYPE[raw.code] as ObjType, data };
    } else {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (raw.code === 6) {
        const baseRaw = raws.find((r) => r.offset === raw.baseOffset);
        if (baseRaw === undefined) throw new Error('pack: ofs-delta base missing');
        base = resolve(baseRaw, depth + 1);
      } else {
        const oid = raw.baseOid as string;
        const inPack = [...byOffset.values()].find((o) => hashObject(o.type, o.data) === oid);
        base = inPack ?? resolveBase?.(oid);
        if (base === undefined) {
          // The base may be a not-yet-resolved raw entry; find it by oid.
          const baseRaw = raws.find((r) => {
            if (r.code < 1 || r.code > 4) return false;
            return hashObject(CODE_TYPE[r.code] as ObjType, r.data) === oid;
          });
          if (baseRaw !== undefined) base = resolve(baseRaw, depth + 1);
        }
        if (base === undefined) throw new Error('pack: ref-delta base missing');
      }
      obj = { type: base.type, data: applyDelta(base.data, data) };
    }
    byOffset.set(raw.offset, obj);
    objects.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (const raw of raws) resolve(raw, 0);
  return { objects, deltaCount };
}

export function verifyPackChecksum(buf: Buffer): { ok: boolean; expected: string; actual: string } {
  if (buf.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  const actual = buf.subarray(buf.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}
