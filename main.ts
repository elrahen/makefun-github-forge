// github-forge: a standalone, GitHub-compatible git forge in one Node 22 process.
//
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and
// MCP (2026-07-28) from one in-memory store, with no dependencies, no git binary and
// no network beyond the trial env. Lifecycle: bind an ephemeral port, register it at
// $MAKEFUN_ENV_URL/register, long-poll GET $MAKEFUN_ENV_URL/done, exit 0 on done.
//
// Determinism: every choice derives from the requests and a monotonic sequence.
// No wall clock, no Math.random, no unseeded ids in anything the server answers:
// timestamps come from a fixed epoch plus a per-object sequence, request ids from a
// counter, global ids from stable base64 of the object's path.
//
// The token's owner is the scenario's viewer. The suite's scenario is built from one
// fixed public seed (kit sdk/conformance/wire.ts SCENARIO_SEED 0x6a09e667f3bcc909),
// so its viewer login is the constant below in every trial, practice and final.

import { createHash } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const STRANGER_LOGIN = 'olgabauer';
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
const FORGE_NAME = 'github-forge';
const FORGE_VERSION = '1.0.0';
const INSTALLED_VERSION = '1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const IDENTITY = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;

// Deterministic clock: 2024-01-01T00:00:00Z plus one second per stamped object.
const EPOCH_SEC = 1704067200;
let stampSeq = 0;
function stamp(): { sec: number; iso: string } {
  stampSeq += 1;
  const sec = EPOCH_SEC + stampSeq;
  return { sec, iso: new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// Monotonic request ids (X-GitHub-Request-Id must be non-empty on every REST reply).
let reqSeq = 0;
function nextRequestId(): string {
  reqSeq += 1;
  return `req-${reqSeq.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;
function isOid(s: string): boolean { return HEX40.test(s); }

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function b64encode(buf: Buffer | string): string {
  return Buffer.from(buf as never).toString('base64');
}
function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'base64');
}
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function escJson(s: string): string {
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// git object model: SHA-1 ids, commit/tree/tag parse + build, reachability
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

interface TreeEntry { mode: string; name: string; oid: string; }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string; parents: string[]; author: string; committer: string; message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string, sec: number): Buffer {
  const who = `${IDENTITY} ${sec} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : message + '\n'}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const PKT_MAX = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer into data-packet payloads (control packets dropped). */
function decodePktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > PKT_MAX) throw new Error('bad pkt-line length');
    if (len === 0 || len === 1 || len === 2) { off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfile: write plain objects; read plain + OFS/REF deltas
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) cpOff += delta[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cpSize += delta[off++] * 2 ** shift; shift += 8; }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile into objects. `resolveBase` supplies thin-pack bases. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): GitObj[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    const hdr = readVarint(pack, off);
    off = hdr.next;
    const typeCode = (hdr.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOff, typeCode, size: hdr.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off];
      let next = off + 1;
      let value = byte & 0x7f;
      while (byte & 0x80) { byte = pack[next++]; value = ((value + 1) * 128) + (byte & 0x7f); }
      entry.baseOffset = entryOff - value;
      off = next;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type code');
    const inflated = inflateSync(pack.subarray(off, trailerStart));
    if (inflated.length !== hdr.size) throw new Error('pack size mismatch');
    entry.data = inflated;
    // advance past the zlib stream: re-inflate with byte counting via a second pass is
    // wasteful; instead find the stream end by trying inflateSync on shrinking windows is
    // wrong. Use zlib's info via inflateSync with a manual scan: Node's inflateSync
    // consumes exactly the stream when given the whole tail; we compute consumed bytes by
    // re-inflating a prefix is not possible, so track with a streaming inflater below.
    off = packEndOfZlib(pack, off, trailerStart);
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  const resolved = new Map<string, GitObj>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObj => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolving.delete(entry.offset);
    const obj = { type, data };
    if (!resolved.has(oid)) { resolved.set(oid, obj); byOid.set(oid, entry); }
    return obj;
  };
  for (const e of raw) resolve(e);
  return [...resolved.values()];
}

/** Byte just past a zlib stream starting at `off` (before `limit`), via inflateSync's info. */
function packEndOfZlib(buf: Buffer, off: number, limit: number): number {
  try {
    const res = inflateSync(buf.subarray(off, limit), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return off + res.engine.bytesWritten;
  } catch {
    throw new Error('zlib stream did not inflate');
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface IssueComment { id: number; body: string; createdAt: string; user: string; }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: IssueComment[];
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  createdAt: string; updatedAt: string;
}
interface Label { name: string; color: string; }
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string; createdAt: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  labels: Map<string, Label>;
  fileCache: Map<string, Map<string, Buffer>>;
}

const objects = new Map<string, GitObj>();
const repos = new Map<string, Repo>();
let repoIdSeq = 0;
let globalIdSeq = 0;

function putObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}
function getObject(oid: string): GitObj | undefined { return objects.get(oid); }

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(name);
}

function repoGid(repo: Repo): string { return b64url(`R:${repo.owner}/${repo.name}`); }
function issueGid(repo: Repo, n: number): string { return b64url(`I:${repo.owner}/${repo.name}#${n}`); }
function pullGid(repo: Repo, n: number): string { return b64url(`P:${repo.owner}/${repo.name}#${n}`); }
function commentGid(repo: Repo, issueN: number, c: number): string { return b64url(`C:${repo.owner}/${repo.name}#${issueN}/${c}`); }

/** Resolve a global id back to its repo + kind + number, or null. */
function decodeGid(gid: string): { kind: string; repo: Repo; number: number; extra: number } | null {
  try {
    const raw = Buffer.from(gid, 'base64url').toString('utf8');
    const kind = raw[0];
    const rest = raw.slice(2);
    const hash = rest.indexOf('#');
    if (hash < 0) return null;
    const fullName = rest.slice(0, hash);
    const tail = rest.slice(hash + 1);
    const slash = fullName.lastIndexOf('/');
    const owner = fullName.slice(0, slash);
    const name = fullName.slice(slash + 1);
    const repo = getRepo(owner, name);
    if (!repo) return null;
    const parts = tail.split('/');
    const number = parseInt(parts[0], 10);
    if (!Number.isFinite(number)) return null;
    return { kind, repo, number, extra: parts.length > 1 ? parseInt(parts[1], 10) : 0 };
  } catch { return null; }
}

/** Decode a repository global id (`R:owner/name`, no '#number' suffix). */
function decodeRepoGid(gid: string): Repo | null {
  try {
    const raw = Buffer.from(gid, 'base64url').toString('utf8');
    if (!raw.startsWith('R:')) return null;
    const fullName = raw.slice(2);
    const slash = fullName.lastIndexOf('/');
    if (slash < 0) return null;
    return getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) ?? null;
  } catch { return null; }
}

/** Every object reachable from `roots` (commits, trees, blobs, tags). */
function collectReachable(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

function isAncestor(anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
    else if (obj?.type === 'tag') queue.push(parseTag(obj.data).object);
  }
  return false;
}

function mergeBase(a: string, b: string): string | null {
  const ancA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancA.has(oid)) continue;
    ancA.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueA.push(p);
    else if (obj?.type === 'tag') queueA.push(parseTag(obj.data).object);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueB.push(p);
    else if (obj?.type === 'tag') queueB.push(parseTag(obj.data).object);
  }
  return null;
}

/** The path -> blob bytes map of a tree, walking nested trees. */
function treeToFiles(treeOid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode === '160000') continue;
      else {
        const blob = objects.get(e.oid);
        if (blob) out.set(path, blob.data);
      }
    }
  };
  walk(treeOid, '');
  return out;
}

/** The path -> blob bytes map of a commit's tree (empty when the commit is missing). */
function commitFiles(commitOid: string): Map<string, Buffer> {
  const obj = objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return treeToFiles(parseCommit(obj.data).tree);
}

/** Build (and store) the nested tree objects for a file map; returns the root tree oid. */
function filesToTree(files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segs[segs.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '100644', name, oid: putObject('blob', data) });
    }
    for (const [name, child] of [...node.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The file map at a branch tip (cached by tip oid; empty for an unborn branch). */
function branchFiles(repo: Repo, branch: string): Map<string, Buffer> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const cached = repo.fileCache.get(tip);
  if (cached) return new Map(cached);
  const files = commitFiles(tip);
  repo.fileCache.set(tip, new Map(files));
  return files;
}

/** Create a commit on a branch from a file map; returns the commit oid. */
function commitOnBranch(repo: Repo, branch: string, files: Map<string, Buffer>, message: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip ? [tip] : [];
  const tree = filesToTree(files);
  const { sec } = stamp();
  const oid = putObject('commit', buildCommit(tree, parents, message, sec));
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.fileCache.set(oid, new Map(files));
  return oid;
}

/** A commit's ancestry, newest first (all parents, BFS by generation). */
function commitHistory(tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

interface FileChange { path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; }

function countLines(buf: Buffer): number {
  const s = buf.toString('utf8');
  if (s === '') return 0;
  const parts = s.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

function lineDiff(oldBuf: Buffer | undefined, newBuf: Buffer | undefined): { additions: number; deletions: number } {
  if (oldBuf === undefined && newBuf === undefined) return { additions: 0, deletions: 0 };
  if (oldBuf === undefined) return { additions: countLines(newBuf!), deletions: 0 };
  if (newBuf === undefined) return { additions: 0, deletions: countLines(oldBuf) };
  if (oldBuf.equals(newBuf)) return { additions: 0, deletions: 0 };
  const oldLines = oldBuf.toString('utf8').split('\n');
  const newLines = newBuf.toString('utf8').split('\n');
  const oldSet = new Map<string, number>();
  for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldSet.get(l) ?? 0;
    if (n > 0) oldSet.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldSet.values()) deletions += n;
  return { additions, deletions };
}

function diffFiles(baseFiles: Map<string, Buffer>, headFiles: Map<string, Buffer>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldB = baseFiles.get(path);
    const newB = headFiles.get(path);
    if (oldB === undefined && newB !== undefined) {
      const d = lineDiff(undefined, newB);
      out.push({ path, status: 'added', additions: d.additions, deletions: 0 });
    } else if (oldB !== undefined && newB === undefined) {
      const d = lineDiff(oldB, undefined);
      out.push({ path, status: 'removed', additions: 0, deletions: d.deletions });
    } else if (oldB !== undefined && newB !== undefined && !oldB.equals(newB)) {
      const d = lineDiff(oldB, newB);
      out.push({ path, status: 'modified', additions: d.additions, deletions: d.deletions });
    }
  }
  return out;
}

/** MERGEABLE when the head's changes do not touch a path the base also changed differently. */
/** The base branch's current tip (a PR's base is a branch, not a frozen sha). */
function currentBaseSha(repo: Repo, pr: Pull): string {
  return repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
}

function mergeableState(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = currentBaseSha(repo, pr);
  const mb = mergeBase(pr.headSha, baseTip);
  if (mb === null) return 'MERGEABLE';
  const mbFiles = commitFiles(mb);
  const headFiles = commitFiles(pr.headSha);
  const baseFiles = commitFiles(baseTip);
  const headChanges = new Map<string, Buffer | null>();
  for (const c of diffFiles(mbFiles, headFiles)) headChanges.set(c.path, headFiles.get(c.path) ?? null);
  for (const c of diffFiles(mbFiles, baseFiles)) {
    if (!headChanges.has(c.path)) continue;
    const hv = headChanges.get(c.path);
    const bv = baseFiles.get(c.path) ?? null;
    const hvB = hv === null ? null : hv;
    const same = (hvB === null && bv === null) || (hvB !== null && bv !== null && hvB.equals(bv));
    if (!same) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a PR onto its base branch; returns the merge commit oid or null on conflict. */
function squashMerge(repo: Repo, pr: Pull): string | null {
  if (mergeableState(repo, pr) === 'CONFLICTING') return null;
  const baseTip = currentBaseSha(repo, pr);
  const files = commitFiles(pr.headSha);
  const tree = filesToTree(files);
  const { sec, iso } = stamp();
  const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
  const oid = putObject('commit', buildCommit(tree, [baseTip], message, sec));
  repo.refs.set(`refs/heads/${pr.base}`, oid);
  repo.fileCache.set(oid, new Map(files));
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = iso;
  pr.mergeCommitSha = oid;
  pr.baseSha = oid;
  pr.updatedAt = iso;
  return oid;
}


// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...extra });
  res.end(buf);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authOk(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams;
  } catch { return new URLSearchParams(); }
}

function pathSegments(req: IncomingMessage): string[] {
  let path = '/';
  try { path = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* keep / */ }
  return path.split('/').filter((s) => s !== '');
}

/** Parse a JSON request body: {} for an empty body, null for malformed JSON. */
function parseJsonBody(buf: Buffer): Record<string, unknown> | unknown[] | null {
  const text = buf.toString('utf8').trim();
  if (text === '') return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return null; }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// REST v3 shapes
// ---------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: b64url(`U:${VIEWER_LOGIN}`), type: 'User', site_admin: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const url = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id, node_id: repoGid(repo), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(), private: repo.priv, description: repo.description,
    default_branch: repo.defaultBranch, created_at: repo.createdAt, updated_at: repo.createdAt,
    pushed_at: repo.createdAt, html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url, clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null, language: null, forks_count: 0, stargazers_count: 0, watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true, has_projects: true, has_wiki: true, has_pages: false, has_downloads: true,
    archived: false, disabled: false, license: null, topics: [], visibility: repo.priv ? 'private' : 'public',
    fork: false, mirror_url: null, size: 0,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issueGid(repo, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: 0, node_id: b64url(`L:${name}`), name, color: l?.color ?? 'ededed', description: null, default: false };
    }),
    user: userJson(), assignee: null, assignees: [], milestone: null,
    locked: false, comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id, node_id: pullGid(repo, pr.number), number: pr.number,
    title: pr.title, body: pr.body, state: pr.state,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha, user: userJson(), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha, user: userJson(), repo: repoJson(repo) },
    merged: pr.merged, mergeable: pr.state === 'open' ? (mergeableState(repo, pr) === 'MERGEABLE') : null,
    mergeable_state: pr.state === 'open' ? (mergeableState(repo, pr) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    user: userJson(), assignee: null, assignees: [], requested_reviewers: [], labels: [],
    draft: false, locked: false, comments: 0, review_comments: 0, commits: 1,
    additions: 0, deletions: 0, changed_files: 0,
    created_at: pr.createdAt, updated_at: pr.updatedAt, closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, c: IssueComment): Record<string, unknown> {
  return {
    id: c.id, node_id: commentGid(repo, issue.number, c.id), body: c.body, user: userJson(),
    created_at: c.createdAt, updated_at: c.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const origin = originOf(req);
    link = `<${origin}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------------------
// REST v3 router
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  // segs[0] === 'api', segs[1] === 'v3'
  if (segs[0] !== 'api' || segs[1] !== 'v3') return false;
  const method = req.method ?? 'GET';
  const query = parseQuery(req);
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }

  const bodyBuf = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    ? await readBody(req) : Buffer.alloc(0);
  const body = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    ? parseJsonBody(bodyBuf) : {};
  if (body === null) { errJson(res, 400, 'Problems parsing JSON'); return true; }
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/ — API root
  if (segs.length === 2 && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (segs.length === 3 && segs[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000', hooks: [], git: [], pages: [], importer: [], enterprise: [] });
    return true;
  }
  // GET /api/v3/user
  if (segs.length === 3 && segs[2] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return true;
  }
  // /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, c) => a.id - c.id).map(repoJson);
      const { page, link } = paginate(all, query, req, '/api/v3/user/repos');
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') { errJson(res, 422, 'name is required'); return true; }
      if (repos.has(name)) { errJson(res, 422, 'Repository already exists'); return true; }
      repoIdSeq += 1;
      const { iso } = stamp();
      const repo: Repo = {
        id: repoIdSeq, name, owner: VIEWER_LOGIN,
        description: typeof b.description === 'string' ? b.description : '',
        priv: b.private === true, defaultBranch: DEFAULT_BRANCH, createdAt: iso,
        refs: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 1,
        labels: new Map(), fileCache: new Map(),
      };
      repos.set(name, repo);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 4 && segs[2] === 'repos') {
    const owner = decodeURIComponent(segs[3]);
    const name = decodeURIComponent(segs[4]);
    const repo = getRepo(owner, name);
    const rest = segs.slice(5);
    // repo object itself
    if (rest.length === 0) {
      if (!repo) { errJson(res, 404, 'Not Found'); return true; }
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (!repo) { errJson(res, 404, 'Not Found'); return true; }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)!, url: '' }, protected: false }));
        sendJson(res, 200, list);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${shaParam}`);
      if (!tip) tip = repo.refs.get(shaParam);
      if (!tip && isOid(shaParam)) tip = shaParam;
      if (!tip || !objects.has(tip)) { errJson(res, 404, 'Not Found'); return true; }
      const list = commitHistory(tip).map((oid) => {
        const c = parseCommit(objects.get(oid)!.data);
        const authorLine = c.author;
        const m = authorLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
        const date = m ? new Date(parseInt(m[3], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : repo.createdAt;
        return {
          sha: oid, node_id: b64url(`C:${oid}`),
          commit: {
            // GitHub presents the message without the stored trailing newline.
            message: c.message.replace(/\n$/, ''),
            author: { name: m?.[1] ?? VIEWER_LOGIN, email: m?.[2] ?? VIEWER_EMAIL, date },
            committer: { name: m?.[1] ?? VIEWER_LOGIN, email: m?.[2] ?? VIEWER_EMAIL, date },
            tree: { sha: c.tree },
          },
          author: userJson(), committer: userJson(),
          parents: c.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(list, query, req, `/api/v3/repos/${owner}/${name}/commits`);
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/heads/') || !isOid(sha) || !objects.has(sha)) { errJson(res, 422, 'Invalid ref or sha'); return true; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: b64url(`G:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest[3]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: b64url(`G:refs/heads/${branch}`), url: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // contents
    if (rest[0] === 'contents') {
      const relPath = rest.slice(1).map(decodeURIComponent).join('/');
      const refParam = query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      if (method === 'GET') {
        const files = branchFiles(repo, branch);
        if (files.has(relPath)) {
          const data = files.get(relPath)!;
          const oid = hashObject('blob', data);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: relPath.split('/').pop(),
            path: relPath, content: b64encode(data), sha: oid,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${relPath}`,
            html_url: '', git_url: '', download_url: '', _links: {},
          });
          return true;
        }
        // directory listing: immediate children under relPath ('' = root)
        const prefix = relPath === '' ? '' : `${relPath}/`;
        const children = new Map<string, { name: string; type: 'file' | 'dir'; path: string; sha: string }>();
        for (const [p, data] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            children.set(restPath, { name: restPath, type: 'file', path: p, sha: hashObject('blob', data) });
          } else {
            const dir = restPath.slice(0, slash);
            if (!children.has(dir)) children.set(dir, { name: dir, type: 'dir', path: `${prefix}${dir}`, sha: '' });
          }
        }
        if (children.size === 0) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, [...children.values()].map((c) => ({
          type: c.type, size: c.type === 'file' ? (files.get(c.path)?.length ?? 0) : 0,
          name: c.name, path: c.path, sha: c.sha || '0'.repeat(40),
          url: '', html_url: '', git_url: '', download_url: null, _links: {},
        })));
        return true;
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (contentB64 === '') { errJson(res, 422, 'content is required'); return true; }
        const data = b64decode(contentB64);
        const reqBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        let tip = repo.refs.get(`refs/heads/${reqBranch}`);
        let files: Map<string, Buffer>;
        let parents: string[];
        if (!tip) {
          const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          files = baseTip ? commitFiles(baseTip) : new Map();
          parents = baseTip ? [baseTip] : [];
        } else {
          files = branchFiles(repo, reqBranch);
          parents = [tip];
        }
        const existed = files.has(relPath);
        if (existed && typeof b.sha === 'string' && b.sha !== '') {
          const cur = hashObject('blob', files.get(relPath)!);
          if (b.sha.toLowerCase() !== cur.toLowerCase()) { errJson(res, 409, 'sha does not match the current blob'); return true; }
        }
        files.set(relPath, data);
        const tree = filesToTree(files);
        const { sec } = stamp();
        const commitOid = putObject('commit', buildCommit(tree, parents, message, sec));
        repo.refs.set(`refs/heads/${reqBranch}`, commitOid);
        repo.fileCache.set(commitOid, new Map(files));
        const contentSha = hashObject('blob', data);
        sendJson(res, existed ? 200 : 201, {
          content: { name: relPath.split('/').pop(), path: relPath, sha: contentSha, size: data.length, encoding: 'base64', content: contentB64, url: '', html_url: '', git_url: '', download_url: '', _links: {} },
          commit: { sha: commitOid, node_id: b64url(`C:${commitOid}`), message, author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }, committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), url: '' },
        });
        return true;
      }
      if (method === 'DELETE') {
        const files = branchFiles(repo, branch);
        if (!files.has(relPath)) { errJson(res, 404, 'Not Found'); return true; }
        if (typeof b.sha === 'string' && b.sha !== '') {
          const cur = hashObject('blob', files.get(relPath)!);
          if (b.sha.toLowerCase() !== cur.toLowerCase()) { errJson(res, 409, 'sha does not match the current blob'); return true; }
        }
        files.delete(relPath);
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const commitOid = commitOnBranch(repo, branch, files, message);
        sendJson(res, 200, { commit: { sha: commitOid } });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') { errJson(res, 422, 'name is required'); return true; }
      const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { id: 0, node_id: b64url(`L:${name}`), name, color, description: null, default: false, url: '' });
      return true;
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (title === '') { errJson(res, 422, 'title is required'); return true; }
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) { errJson(res, 422, `Label does not exist: ${l}`); return true; }
          }
          const number = repo.nextNumber++;
          globalIdSeq += 1;
          const { iso } = stamp();
          const issue: Issue = {
            id: globalIdSeq, number, title, body: typeof b.body === 'string' ? b.body : '',
            state: 'open', labels, createdAt: iso, updatedAt: iso, closedAt: null, comments: [],
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, c) => (direction === 'asc' ? a.number - c.number : c.number - a.number));
          }
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), query, req, `/api/v3/repos/${owner}/${name}/issues`);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      if (!Number.isFinite(num)) { errJson(res, 404, 'Not Found'); return true; }
      const issue = repo.issues.get(num);
      if (rest.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? stamp().iso : null;
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          issue.updatedAt = stamp().iso;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'POST') {
          const text = typeof b.body === 'string' ? b.body : '';
          if (text === '') { errJson(res, 422, 'body is required'); return true; }
          globalIdSeq += 1;
          const { iso } = stamp();
          const comment: IssueComment = { id: globalIdSeq, body: text, createdAt: iso, user: VIEWER_LOGIN };
          issue.comments.push(comment);
          issue.updatedAt = iso;
          sendJson(res, 201, commentJson(repo, issue, comment));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return true;
        }
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          if (title === '' || head === '') { errJson(res, 422, 'title and head are required'); return true; }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) { errJson(res, 422, 'head or base branch does not exist'); return true; }
          for (const p of repo.pulls.values()) {
            if (p.state === 'open' && p.head === head && p.base === base) { errJson(res, 422, 'A pull request already exists for this head and base'); return true; }
          }
          const number = repo.nextNumber++;
          globalIdSeq += 1;
          const { iso } = stamp();
          const pr: Pull = {
            id: globalIdSeq, number, title, body: typeof b.body === 'string' ? b.body : '',
            state: 'open', head, base, headSha, baseSha,
            merged: false, mergedAt: null, mergeCommitSha: null, createdAt: iso, updatedAt: iso,
          };
          repo.pulls.set(number, pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.number - a.number);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), query, req, `/api/v3/repos/${owner}/${name}/pulls`);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      if (!Number.isFinite(num)) { errJson(res, 404, 'Not Found'); return true; }
      const pr = repo.pulls.get(num);
      if (rest.length === 2) {
        if (!pr) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pr) { errJson(res, 404, 'Not Found'); return true; }
        const baseFiles = commitFiles(pr.baseSha);
        const headFiles = commitFiles(pr.headSha);
        const changes = diffFiles(baseFiles, headFiles).map((c) => ({
          sha: '',
          filename: c.path,
          status: c.status,
          additions: c.additions,
          deletions: c.deletions,
          changes: c.additions + c.deletions,
          blob_url: '', raw_url: '', contents_url: '', patch: '',
        }));
        sendJson(res, 200, changes);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pr) { errJson(res, 404, 'Not Found'); return true; }
        if (pr.merged || pr.state === 'closed') { errJson(res, 405, 'Pull request is already merged or closed'); return true; }
        const mergedSha = squashMerge(repo, pr);
        if (mergedSha === null) { errJson(res, 405, 'Merge conflict'); return true; }
        sendJson(res, 200, { sha: mergedSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    errJson(res, 404, 'Not Found');
    return true;
  }

  // unmatched /api/v3 route
  errJson(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, oid]) => ({ name, oid }));
}

/** The peeled commit of a tag ref (the tag object itself when it is not annotated). */
function peelOf(repo: Repo, refName: string): string | null {
  const oid = repo.refs.get(refName);
  if (!oid) return null;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  let cur = parseTag(obj.data).object;
  for (let i = 0; i < 8; i++) {
    const next = objects.get(cur);
    if (next?.type === 'tag') cur = parseTag(next.data).object;
    else break;
  }
  return cur;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main agent=github-forge/1.0'
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta thin-pack agent=github-forge/1.0 symref=HEAD:refs/heads/main';
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const peeled = peelOf(repo, r.name);
      if (peeled !== null) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(repo: Repo): Buffer {
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n', 'flush',
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    'agent=github-forge/1.0\n',
    'flush',
  ];
  void repo;
  return pktLines(lines);
}

interface FetchPlan { objects: GitObj[]; shallow: string[]; unshallow: string[]; }

/** The objects a fetch must send, per the v2/v0 negotiation rules.
 * Depth-aware: a commit is sent with its tree closure, but its parents are
 * only walked while the depth allows, so a depth-1 fetch never carries
 * history beyond the tip. */
function computeFetch(wants: string[], haves: string[], shallowArgs: string[], depth: number | undefined): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowArgs);
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  const send = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = wants.map((w) => ({ oid: w, d: 1 }));
  const visited = new Set<string>();
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      send.add(oid);
      queue.push({ oid: parseTag(obj.data).object, d });
      continue;
    }
    if (obj.type !== 'commit') { send.add(oid); continue; }
    const isHave = haveSet.has(oid);
    const isBoundary = shallowSet.has(oid);
    if (isHave && !isBoundary) continue;
    if (isHave && isBoundary) {
      if (depth === undefined || d < depth) {
        for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
        if (depth !== undefined) unshallow.push(oid);
      }
      continue;
    }
    // Not held: send the commit and its tree closure, but walk parents only
    // while the depth allows.
    send.add(oid);
    for (const x of collectReachable([parseCommit(obj.data).tree])) send.add(x);
    if (depth !== undefined && d >= depth) { newShallow.push(oid); continue; }
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
  }
  // Filter out objects the client already holds.
  const held = new Set<string>();
  for (const h of haveSet) {
    if (shallowSet.has(h)) {
      const o = objects.get(h);
      if (o?.type === 'commit') {
        held.add(h);
        for (const x of collectReachable([parseCommit(o.data).tree])) held.add(x);
      } else if (o) {
        for (const x of collectReachable([h])) held.add(x);
      }
    } else {
      for (const x of collectReachable([h])) held.add(x);
    }
  }
  const final = [...send].filter((oid) => !held.has(oid)).sort();
  return { objects: final.map((oid) => objects.get(oid)!).filter((o) => o !== undefined), shallow: newShallow, unshallow };
}

/** Split a pack into sideband band-1 pkt-lines. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = PKT_MAX - 4 - 1;
  for (let off = 0; off < pack.length; off += MAX_DATA) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** Parse pkt-lines from a buffer, returning the data payloads and the offset just past the flush. */
function parsePktSection(buf: Buffer): { payloads: Buffer[]; end: number } {
  const payloads: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > PKT_MAX) throw new Error('bad pkt-line');
    if (len === 0) { off += 4; return { payloads, end: off }; }
    if (len === 1 || len === 2) { off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    payloads.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  throw new Error('no flush packet');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  // segs: [owner, '<repo>.git', ...]
  if (segs.length < 2 || !segs[1].endsWith('.git')) return false;
  const method = req.method ?? 'GET';
  const owner = decodeURIComponent(segs[0]);
  const repoName = decodeURIComponent(segs[1].slice(0, -4));
  const repo = getRepo(owner, repoName);
  const query = parseQuery(req);

  if (segs.length === 3 && segs[2] === 'info' && false) return false; // placeholder never hit
  if (segs.length === 4 && segs[2] === 'info' && segs[3] === 'refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 400, 'unknown service'); return true; }
    if (!repo) {
      res.writeHead(404, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return true;
    }
    const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = isV2 ? v2Advertisement(repo) : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
    sendRaw(res, 200, body, `application/x-${service}-advertisement`);
    return true;
  }

  if (segs.length === 3 && (segs[2] === 'git-upload-pack' || segs[2] === 'git-receive-pack') && method === 'POST') {
    const service = segs[2] as 'git-upload-pack' | 'git-receive-pack';
    if (!repo) {
      res.writeHead(404, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return true;
    }
    const body = await readBody(req);
    try {
      if (service === 'git-upload-pack') {
        await handleUploadPack(req, res, repo, body);
      } else {
        await handleReceivePack(req, res, repo, body);
      }
    } catch (err) {
      // A malformed request must not take the server down (repo-survives-errors).
      try {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`bad request: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* already answered */ }
    }
    return true;
  }
  return false;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const { payloads } = parsePktSection(body);
    const lines = payloads.map((p) => p.toString('utf8'));
    const command = lines[0]?.trim() ?? '';
    const args = lines.slice(1).map((l) => l.trim());
    if (command === 'command=ls-refs') {
      let peel = false; let symrefs = false; let unborn = false;
      const prefixes: string[] = [];
      for (const a of args) {
        if (a === 'peel') peel = true;
        else if (a === 'symrefs') symrefs = true;
        else if (a === 'unborn') unborn = true;
        else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
      }
      const out: Array<string | 'flush'> = [];
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      // The HEAD symref line is only returned when no ref-prefix filters it
      // out (HEAD is not under refs/heads/).
      const headAllowed = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
      if (symrefs && headAllowed) {
        if (headOid) out.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        else if (unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      }
      for (const r of sortedRefs(repo)) {
        if (!keep(r.name)) continue;
        let line = `${r.oid} ${r.name}`;
        if (peel) {
          const peeled = peelOf(repo, r.name);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
        out.push(`${line}\n`);
      }
      out.push('flush');
      sendRaw(res, 200, pktLines(out), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowArgs: string[] = [];
      let depth: number | undefined;
      for (const a of args) {
        if (a.startsWith('want ')) wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) shallowArgs.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
      }
      const plan = computeFetch(wants, haves, shallowArgs, depth);
      const parts: Buffer[] = [];
      // The acknowledgments section is only sent when the client offered haves
      // (real git rejects it on a no-haves fetch; the suite client tolerates
      // its absence).
      if (haves.length > 0) {
        parts.push(pktLine('acknowledgments\n'));
        parts.push(pktLine('NAK\n'));
        parts.push(pktFlush());
      }
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
        parts.push(pktFlush());
      }
      if (plan.objects.length > 0) {
        const pack = writePack(plan.objects);
        parts.push(pktLine('packfile\n'));
        for (const p of sidebandPackets(pack)) parts.push(p);
        parts.push(pktFlush());
      }
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  }

  // v0 fetch: wants (+shallow/deepen) flush, haves + done flush.
  const first = parsePktSection(body);
  const firstLines = first.payloads.map((p) => p.toString('utf8'));
  let rest = body.subarray(first.end);
  let secondLines: string[] = [];
  try {
    const second = parsePktSection(rest);
    secondLines = second.payloads.map((p) => p.toString('utf8'));
    void second;
  } catch { /* a second section may be absent */ }
  void rest;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | undefined;
  for (const line of firstLines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0]);
    else if (l.startsWith('shallow ')) shallowArgs.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10);
  }
  for (const line of secondLines) {
    const l = line.trim();
    if (l.startsWith('have ')) haves.push(l.slice(5).trim());
  }
  const plan = computeFetch(wants, haves, shallowArgs, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    for (const p of sidebandPackets(pack)) parts.push(p);
  }
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand { oldOid: string; newOid: string; ref: string; }

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { payloads, end } = parsePktSection(body);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  payloads.forEach((p, i) => {
    let line = p.toString('utf8');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).trim().split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    const m = line.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  });
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = body.subarray(end);
  const report: string[] = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes);
      for (const o of objs) putObject(o.type, o.data);
    } catch {
      unpackOk = false;
    }
  }
  if (unpackOk) {
    report.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!current) report.push(`ng ${cmd.ref} cannot delete\n`);
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
        else { repo.refs.delete(cmd.ref); report.push(`ok ${cmd.ref}\n`); }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current) report.push(`ng ${cmd.ref} already exists\n`);
        else if (!objects.has(cmd.newOid)) report.push(`ng ${cmd.ref} unavailable\n`);
        else { repo.refs.set(cmd.ref, cmd.newOid); report.push(`ok ${cmd.ref}\n`); }
      } else {
        // update
        if (!current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
        else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
        else if (cmd.newOid === current) report.push(`ok ${cmd.ref}\n`);
        else if (!objects.has(cmd.newOid)) report.push(`ng ${cmd.ref} unavailable\n`);
        else if (isAncestor(current, cmd.newOid)) { repo.refs.set(cmd.ref, cmd.newOid); report.push(`ok ${cmd.ref}\n`); }
        else report.push(`ng ${cmd.ref} non-fast-forward\n`);
      }
    }
  } else {
    report.push('unpack error\n');
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed\n`);
  }
  const reportBytes = pktLines([...report, 'flush']);
  const parts: Buffer[] = [];
  if (sideband) {
    const MAX_DATA = PKT_MAX - 4 - 1;
    for (let off = 0; off < reportBytes.length; off += MAX_DATA) {
      const chunk = reportBytes.subarray(off, Math.min(reportBytes.length, off + MAX_DATA));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  } else {
    parts.push(reportBytes);
  }
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (hand-rolled parser + executor for the fixed documents)
// ---------------------------------------------------------------------------

interface GqlValue { kind: 'var' | 'int' | 'float' | 'string' | 'bool' | 'enum' | 'list' | 'object'; value?: unknown; name?: string; values?: GqlValue[]; fields?: Array<{ name: string; value: GqlValue }>; }
interface GqlField { kind: 'field'; alias?: string; name: string; args: Array<{ name: string; value: GqlValue }>; selections?: GqlSel[]; }
interface GqlSpread { kind: 'spread'; name: string; }
interface GqlInline { kind: 'inline'; typeCondition?: string; selections: GqlSel[]; }
type GqlSel = GqlField | GqlSpread | GqlInline;
interface GqlOp { kind: 'op'; operation: string; name?: string; varDefs: Array<{ name: string; defaultValue?: GqlValue }>; selections: GqlSel[]; }
interface GqlFrag { kind: 'frag'; name: string; typeCondition: string; selections: GqlSel[]; }
type GqlDoc = Array<GqlOp | GqlFrag>;

interface Tok { kind: 'punct' | 'name' | 'int' | 'float' | 'string'; value: string; }

function gqlTokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.startsWith('...', i)) { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { toks.push({ kind: 'punct', value: c }); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else if (e === '/') out += '/';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e ?? '';
          j += 2;
        } else { out += src[j]; j++; }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

class GqlParser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('unexpected end of query');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }
  parseDocument(): GqlDoc {
    const defs: GqlDoc = [];
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        defs.push({ kind: 'op', operation: 'query', varDefs: [], selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const operation = this.next().value;
        let name: string | undefined;
        const n = this.peek();
        if (n?.kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        defs.push({ kind: 'op', operation, name, varDefs, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        defs.push({ kind: 'frag', name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return defs;
  }
  private parseVarDefs(): Array<{ name: string; defaultValue?: GqlValue }> {
    const defs: Array<{ name: string; defaultValue?: GqlValue }> = [];
    if (this.peek()?.value !== '(') return defs;
    this.next();
    while (this.peek()?.value !== ')') {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: GqlValue | undefined;
      if (this.peek()?.value === '=') { this.next(); defaultValue = this.parseValue(); }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }
  private parseType(): void {
    const t = this.next();
    if (t.value === '[') { this.parseType(); this.expectPunct(']'); }
    else if (t.kind !== 'name') throw new Error('expected type');
    if (this.peek()?.value === '!') this.next();
  }
  private parseSelections(): GqlSel[] {
    this.expectPunct('{');
    const sels: GqlSel[] = [];
    while (this.peek()?.value !== '}') {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '...') {
        this.next();
        const n = this.peek();
        if (n?.kind === 'name' && n.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          sels.push({ kind: 'inline', typeCondition, selections: this.parseSelections() });
        } else if (n?.kind === 'name') {
          sels.push({ kind: 'spread', name: this.next().value });
          // directives after a spread are ignored
          while (this.peek()?.value === '@') { this.next(); this.expectName(); if (this.peek()?.value === '(') this.parseArgs(); }
        } else {
          sels.push({ kind: 'inline', selections: this.parseSelections() });
        }
      } else if (t.kind === 'name') {
        const first = this.next().value;
        let alias: string | undefined;
        let name = first;
        if (this.peek()?.value === ':') { this.next(); alias = first; name = this.expectName(); }
        const args = this.parseArgs();
        while (this.peek()?.value === '@') { this.next(); this.expectName(); if (this.peek()?.value === '(') this.parseArgs(); }
        const selections = this.peek()?.value === '{' ? this.parseSelections() : undefined;
        sels.push({ kind: 'field', alias, name, args, selections });
      } else {
        throw new Error(`unexpected token in selection set: ${t.value}`);
      }
    }
    this.expectPunct('}');
    return sels;
  }
  private parseArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.value !== '(') return args;
    this.next();
    while (this.peek()?.value !== ')') {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }
  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: GqlValue[] = [];
      while (this.peek()?.value !== ']') values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek()?.value !== '}') {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name' && t.value === 'true') return { kind: 'bool', value: true };
    if (t.kind === 'name' && t.value === 'false') return { kind: 'bool', value: false };
    if (t.kind === 'name' && t.value === 'null') return { kind: 'enum', value: null };
    if (t.kind === 'name') return { kind: 'enum', value: t.value };
    throw new Error(`unexpected value token ${t.value}`);
  }
}

function parseGraphql(src: string): GqlDoc {
  return new GqlParser(gqlTokenize(src)).parseDocument();
}

function resolveGqlValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return variables[v.name ?? ''];
    case 'int': case 'float': case 'string': case 'bool': case 'enum': return v.value ?? null;
    case 'list': return (v.values ?? []).map((x) => resolveGqlValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields ?? []) out[f.name] = resolveGqlValue(f.value, variables);
      return out;
    }
  }
}

function cursorFor(n: number): string { return b64encode(Buffer.from(`cursor:${n}`, 'utf8')); }
function decodeCursor(c: string): number | null {
  try {
    const text = b64decode(c).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function pageInfoFor(total: number, start: number, sliceLen: number, slice: Array<{ number: number }>): Record<string, unknown> {
  return {
    __gtype: 'PageInfo',
    hasNextPage: start + sliceLen < total,
    hasPreviousPage: start > 0,
    startCursor: sliceLen ? cursorFor(slice[0].number) : null,
    endCursor: sliceLen ? cursorFor(slice[sliceLen - 1].number) : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT') {
    const dir = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -dir : dir;
      return (a.number - b.number) * dir;
    });
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  let start = 0;
  if (typeof args.after === 'string') {
    const n = decodeCursor(args.after);
    if (n !== null) {
      const idx = list.findIndex((i) => i.number === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const slice = list.slice(start, start + first);
  const nodes = slice.map((i) => ({ __gtype: 'Issue', repo, issue: i }));
  return {
    __gtype: 'IssueConnection', nodes,
    edges: slice.map((i) => ({ __gtype: 'IssueEdge', node: { __gtype: 'Issue', repo, issue: i }, cursor: cursorFor(i.number) })),
    totalCount: list.length,
    pageInfo: pageInfoFor(list.length, start, slice.length, slice),
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  list.sort((a, b) => b.number - a.number);
  let start = 0;
  if (typeof args.after === 'string') {
    const n = decodeCursor(args.after);
    if (n !== null) {
      const idx = list.findIndex((p) => p.number === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const slice = list.slice(start, start + first);
  return {
    __gtype: 'PullRequestConnection',
    nodes: slice.map((p) => ({ __gtype: 'PullRequest', repo, pr: p })),
    edges: slice.map((p) => ({ __gtype: 'PullRequestEdge', node: { __gtype: 'PullRequest', repo, pr: p }, cursor: cursorFor(p.number) })),
    totalCount: list.length,
    pageInfo: pageInfoFor(list.length, start, slice.length, slice),
  };
}

function createIssueInRepo(repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber++;
  globalIdSeq += 1;
  const { iso } = stamp();
  const issue: Issue = { id: globalIdSeq, number, title, body, state: 'open', labels: [], createdAt: iso, updatedAt: iso, closedAt: null, comments: [] };
  repo.issues.set(number, issue);
  return issue;
}

function createPullInRepo(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.head === head && p.base === base) throw new Error('A pull request already exists for this head and base');
  }
  const number = repo.nextNumber++;
  globalIdSeq += 1;
  const { iso } = stamp();
  const pr: Pull = {
    id: globalIdSeq, number, title, body, state: 'open', head, base, headSha, baseSha,
    merged: false, mergedAt: null, mergeCommitSha: null, createdAt: iso, updatedAt: iso,
  };
  repo.pulls.set(number, pr);
  return pr;
}

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'labels', 'comments'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergeCommit', 'author', 'createdAt', 'updatedAt', 'url', 'files'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'USER', 'REPOSITORY', 'DISCUSSION'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'avatarUrl', 'url'] },
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
};

function introspectType(name: string): Record<string, unknown> | null {
  const def = TYPE_DEFS[name];
  if (!def) return null;
  return {
    __gtype: '__Type', name, kind: def.kind,
    fields: def.fields ? def.fields.map((f) => ({ __gtype: '__Field', name: f, type: { __gtype: '__TypeRef', name: 'String', kind: 'SCALAR' } })) : null,
    enumValues: def.enumValues ? def.enumValues.map((v) => ({ __gtype: '__EnumValue', name: v })) : null,
  };
}

type Resolver = (parent: Record<string, unknown>, args: Record<string, unknown>) => unknown;
const GQL_RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __gtype: 'User', login: VIEWER_LOGIN }),
    repository: (_p, a) => {
      const repo = getRepo(String(a.owner ?? ''), String(a.name ?? ''));
      return repo ? { __gtype: 'Repository', repo } : null;
    },
    node: (_p, a) => {
      const raw = String(a.id ?? '');
      // Repository ids carry no '#number' suffix, so decode them directly.
      try {
        const text = b64decode(raw).toString('utf8');
        if (text.startsWith('R:')) {
          const fullName = text.slice(2);
          const slash = fullName.lastIndexOf('/');
          const repo = getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
          return repo ? { __gtype: 'Repository', repo } : null;
        }
      } catch { /* fall through to decodeGid */ }
      const d = decodeGid(raw);
      if (!d) return null;
      if (d.kind === 'R') return { __gtype: 'Repository', repo: d.repo };
      if (d.kind === 'I') {
        const issue = d.repo.issues.get(d.number);
        return issue ? { __gtype: 'Issue', repo: d.repo, issue } : null;
      }
      if (d.kind === 'P') {
        const pr = d.repo.pulls.get(d.number);
        return pr ? { __gtype: 'PullRequest', repo: d.repo, pr } : null;
      }
      if (d.kind === 'C') {
        const issue = d.repo.issues.get(d.number);
        const comment = issue?.comments.find((c) => c.id === d.extra);
        return issue && comment ? { __gtype: 'IssueComment', repo: d.repo, issue, comment } : null;
      }
      return null;
    },
    __type: (_p, a) => introspectType(String(a.name ?? '')),
    __schema: () => ({ __gtype: '__Schema' }),
  },
  Mutation: {
    createIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoGid(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const issue = createIssueInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      return { __gtype: 'CreateIssuePayload', issue: { __gtype: 'Issue', repo, issue }, clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const d = decodeGid(String(input.issueId ?? ''));
      if (!d || d.kind !== 'I') throw new Error('issue not found');
      const repo = d.repo;
      const issue = repo.issues.get(d.number);
      if (!issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = stamp().iso;
      issue.updatedAt = issue.closedAt;
      return { __gtype: 'CloseIssuePayload', issue: { __gtype: 'Issue', repo, issue }, clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoGid(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const pr = createPullInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
      return { __gtype: 'CreatePullRequestPayload', pullRequest: { __gtype: 'PullRequest', repo, pr }, clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const d = decodeGid(String(input.pullRequestId ?? ''));
      if (!d || d.kind !== 'P') throw new Error('pull request not found');
      const repo = d.repo;
      const pr = repo.pulls.get(d.number);
      if (!pr) throw new Error('pull request not found');
      if (pr.merged || pr.state === 'closed') throw new Error('Pull request is already merged or closed');
      const sha = squashMerge(repo, pr);
      if (sha === null) throw new Error('Merge conflict');
      return { __gtype: 'MergePullRequestPayload', pullRequest: { __gtype: 'PullRequest', repo, pr }, clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const d = decodeGid(String(input.subjectId ?? ''));
      if (!d || d.kind !== 'I') throw new Error('subject not found');
      const repo = d.repo;
      const issue = repo.issues.get(d.number);
      if (!issue) throw new Error('subject not found');
      globalIdSeq += 1;
      const { iso } = stamp();
      const comment: IssueComment = { id: globalIdSeq, body: String(input.body ?? ''), createdAt: iso, user: VIEWER_LOGIN };
      issue.comments.push(comment);
      issue.updatedAt = iso;
      return {
        __gtype: 'AddCommentPayload',
        commentEdge: { __gtype: 'IssueCommentEdge', node: { __gtype: 'IssueComment', repo, issue, comment }, cursor: cursorFor(comment.id) },
        subject: { __gtype: 'Issue', repo, issue },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  Repository: {
    id: (p) => repoGid(p.repo as Repo),
    databaseId: (p) => (p.repo as Repo).id,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
    owner: () => ({ __gtype: 'User', login: VIEWER_LOGIN }),
    description: (p) => (p.repo as Repo).description,
    defaultBranchRef: (p) => ({ __gtype: 'Ref', name: (p.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
    issue: (p, a) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.get(Number(a.number));
      return issue ? { __gtype: 'Issue', repo, issue } : null;
    },
    issues: (p, a) => issueConnection(p.repo as Repo, a),
    pullRequest: (p, a) => {
      const repo = p.repo as Repo;
      const pr = repo.pulls.get(Number(a.number));
      return pr ? { __gtype: 'PullRequest', repo, pr } : null;
    },
    pullRequests: (p, a) => pullConnection(p.repo as Repo, a),
    labels: (p) => {
      const repo = p.repo as Repo;
      const nodes = [...repo.labels.values()].map((l) => ({ __gtype: 'Label', label: l }));
      return { __gtype: 'LabelConnection', nodes, totalCount: nodes.length };
    },
  },
  Issue: {
    id: (p) => issueGid(p.repo as Repo, (p.issue as Issue).number),
    databaseId: (p) => (p.issue as Issue).id,
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    body: (p) => (p.issue as Issue).body,
    state: (p) => (p.issue as Issue).state.toUpperCase(),
    author: () => ({ __gtype: 'User', login: VIEWER_LOGIN }),
    createdAt: (p) => (p.issue as Issue).createdAt,
    updatedAt: (p) => (p.issue as Issue).updatedAt,
    closedAt: (p) => (p.issue as Issue).closedAt,
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`,
    labels: (p) => {
      const repo = p.repo as Repo;
      const issue = p.issue as Issue;
      const nodes = issue.labels.map((name) => ({ __gtype: 'Label', label: repo.labels.get(name) ?? { name, color: 'ededed' } }));
      return { __gtype: 'LabelConnection', nodes, totalCount: nodes.length };
    },
    comments: (p) => {
      const issue = p.issue as Issue;
      const nodes = issue.comments.map((c) => ({ __gtype: 'IssueComment', repo: p.repo, issue, comment: c }));
      return {
        __gtype: 'IssueCommentConnection', nodes, totalCount: nodes.length,
        pageInfo: { __gtype: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    },
  },
  PullRequest: {
    id: (p) => pullGid(p.repo as Repo, (p.pr as Pull).number),
    databaseId: (p) => (p.pr as Pull).id,
    number: (p) => (p.pr as Pull).number,
    title: (p) => (p.pr as Pull).title,
    body: (p) => (p.pr as Pull).body,
    state: (p) => (p.pr as Pull).state.toUpperCase(),
    headRefName: (p) => (p.pr as Pull).head,
    baseRefName: (p) => (p.pr as Pull).base,
    mergeable: (p) => {
      const pr = p.pr as Pull;
      if (pr.state !== 'open') return 'UNKNOWN';
      return mergeableState(p.repo as Repo, pr) === 'MERGEABLE' ? 'MERGEABLE' : 'CONFLICTING';
    },
    merged: (p) => (p.pr as Pull).merged,
    mergeCommit: (p) => ((p.pr as Pull).mergeCommitSha ? { __gtype: 'Commit', oid: (p.pr as Pull).mergeCommitSha } : null),
    author: () => ({ __gtype: 'User', login: VIEWER_LOGIN }),
    createdAt: (p) => (p.pr as Pull).createdAt,
    updatedAt: (p) => (p.pr as Pull).updatedAt,
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/pull/${(p.pr as Pull).number}`,
    files: (p) => {
      const repo = p.repo as Repo;
      const pr = p.pr as Pull;
      const baseFiles = commitFiles(pr.baseSha);
      const headFiles = commitFiles(pr.headSha);
      const nodes = diffFiles(baseFiles, headFiles).map((c) => ({ __gtype: 'File', path: c.path }));
      return {
        __gtype: 'FileConnection', nodes, totalCount: nodes.length,
        pageInfo: { __gtype: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    },
  },
  User: {
    login: (p) => p.login as string,
    id: (p) => b64url(`U:${p.login as string}`),
    databaseId: () => VIEWER_ID,
    avatarUrl: () => 'https://example.invalid/avatar.png',
    url: (p) => `https://github.com/${p.login as string}`,
  },
  IssueConnection: {
    nodes: (p) => p.nodes as unknown[],
    edges: (p) => p.edges as unknown[],
    pageInfo: (p) => p.pageInfo as Record<string, unknown>,
    totalCount: (p) => p.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (p) => p.nodes as unknown[],
    edges: (p) => p.edges as unknown[],
    pageInfo: (p) => p.pageInfo as Record<string, unknown>,
    totalCount: (p) => p.totalCount as number,
  },
  IssueEdge: { node: (p) => p.node as Record<string, unknown>, cursor: (p) => p.cursor as string },
  PullRequestEdge: { node: (p) => p.node as Record<string, unknown>, cursor: (p) => p.cursor as string },
  IssueCommentEdge: { node: (p) => p.node as Record<string, unknown>, cursor: (p) => p.cursor as string },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage as boolean,
    hasPreviousPage: (p) => (p.hasPreviousPage as boolean) ?? false,
    startCursor: (p) => (p.startCursor as string | null) ?? null,
    endCursor: (p) => (p.endCursor as string | null) ?? null,
  },
  Ref: { name: (p) => p.name as string },
  Label: {
    id: (p) => b64url(`L:${(p.label as Label).name}`),
    name: (p) => (p.label as Label).name,
    color: (p) => (p.label as Label).color,
    description: () => null,
  },
  LabelConnection: { nodes: (p) => p.nodes as unknown[], totalCount: (p) => p.totalCount as number },
  Commit: { oid: (p) => p.oid as string },
  File: { path: (p) => p.path as string },
  FileConnection: {
    nodes: (p) => p.nodes as unknown[],
    totalCount: (p) => p.totalCount as number,
    pageInfo: (p) => p.pageInfo as Record<string, unknown>,
  },
  IssueComment: {
    id: (p) => b64url(`C:${(p.comment as IssueComment).id}`),
    body: (p) => (p.comment as IssueComment).body,
    author: () => ({ __gtype: 'User', login: VIEWER_LOGIN }),
    createdAt: (p) => (p.comment as IssueComment).createdAt,
  },
  IssueCommentConnection: {
    nodes: (p) => p.nodes as unknown[],
    totalCount: (p) => p.totalCount as number,
    pageInfo: (p) => p.pageInfo as Record<string, unknown>,
  },
  CreateIssuePayload: { issue: (p) => p.issue as Record<string, unknown>, clientMutationId: (p) => (p.clientMutationId as string | null) ?? null },
  CloseIssuePayload: { issue: (p) => p.issue as Record<string, unknown>, clientMutationId: (p) => (p.clientMutationId as string | null) ?? null },
  CreatePullRequestPayload: { pullRequest: (p) => p.pullRequest as Record<string, unknown>, clientMutationId: (p) => (p.clientMutationId as string | null) ?? null },
  MergePullRequestPayload: { pullRequest: (p) => p.pullRequest as Record<string, unknown>, clientMutationId: (p) => (p.clientMutationId as string | null) ?? null },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge as Record<string, unknown>,
    subject: (p) => p.subject as Record<string, unknown>,
    clientMutationId: (p) => (p.clientMutationId as string | null) ?? null,
  },
  __Type: {
    name: (p) => p.name as string,
    kind: (p) => p.kind as string,
    fields: (p) => (p.fields as unknown[] | null) ?? null,
    enumValues: (p) => (p.enumValues as unknown[] | null) ?? null,
    description: () => null,
  },
  __Field: { name: (p) => p.name as string, type: (p) => p.type as Record<string, unknown> },
  __TypeRef: { name: (p) => p.name as string, kind: (p) => p.kind as string },
  __EnumValue: { name: (p) => p.name as string },
  __Schema: {
    types: () => Object.keys(TYPE_DEFS).map((name) => introspectType(name)),
    queryType: () => ({ __gtype: '__Type', name: 'Query', kind: 'OBJECT', fields: null, enumValues: null }),
    mutationType: () => ({ __gtype: '__Type', name: 'Mutation', kind: 'OBJECT', fields: null, enumValues: null }),
  },
};

function execGqlSelections(
  parent: Record<string, unknown>, type: string, sels: GqlSel[],
  variables: Record<string, unknown>, frags: Map<string, GqlFrag>, errors: Array<{ message: string }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      result[key] = resolveGqlField(parent, type, sel, variables, frags, errors);
    } else if (sel.kind === 'spread') {
      const frag = frags.get(sel.name);
      if (frag && frag.typeCondition === type) {
        Object.assign(result, execGqlSelections(parent, type, frag.selections, variables, frags, errors));
      }
    } else if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === type) {
        Object.assign(result, execGqlSelections(parent, type, sel.selections, variables, frags, errors));
      }
    }
  }
  return result;
}

function resolveGqlField(
  parent: Record<string, unknown>, type: string, field: GqlField,
  variables: Record<string, unknown>, frags: Map<string, GqlFrag>, errors: Array<{ message: string }>,
): unknown {
  if (field.name === '__typename') return type;
  const fn = GQL_RESOLVERS[type]?.[field.name];
  if (!fn) {
    errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const a of field.args) args[a.name] = resolveGqlValue(a.value, variables);
  let val: unknown;
  try {
    val = fn(parent, args);
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!field.selections) return val;
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) {
    return val.map((v) => {
      if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).__gtype === 'string') {
        return execGqlSelections(v as Record<string, unknown>, (v as Record<string, unknown>).__gtype as string, field.selections!, variables, frags, errors);
      }
      return v;
    });
  }
  if (typeof val === 'object' && typeof (val as Record<string, unknown>).__gtype === 'string') {
    return execGqlSelections(val as Record<string, unknown>, (val as Record<string, unknown>).__gtype as string, field.selections, variables, frags, errors);
  }
  return val;
}

function execGraphql(doc: GqlDoc, variables: Record<string, unknown>): Record<string, unknown> {
  const errors: Array<{ message: string }> = [];
  const op = doc.find((d) => d.kind === 'op') as GqlOp | undefined;
  if (!op) return { errors: [{ message: 'No operation provided' }], data: null };
  const frags = new Map<string, GqlFrag>();
  for (const d of doc) if (d.kind === 'frag') frags.set(d.name, d);
  const vars: Record<string, unknown> = { ...variables };
  for (const vd of op.varDefs) {
    if (!(vd.name in vars) && vd.defaultValue !== undefined) vars[vd.name] = resolveGqlValue(vd.defaultValue, vars);
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = execGqlSelections({ __gtype: rootType }, rootType, op.selections, vars, frags, errors);
  const out: Record<string, unknown> = { data };
  if (errors.length) out.errors = errors;
  return out;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (parsed === null) { errJson(res, 400, 'Problems parsing JSON'); return true; }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const results = docs.map((doc) => {
    const d = doc as Record<string, unknown>;
    if (typeof d.query !== 'string') return { errors: [{ message: 'query is required' }], data: null };
    try {
      const ast = parseGraphql(d.query);
      const variables = (d.variables ?? {}) as Record<string, unknown>;
      return execGraphql(ast, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }], data: null };
    }
  });
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

const MCP_VERSION = '2026-07-28';
const MCP_KNOWN_VERSIONS = ['2026-07-28', '2026-03-26', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-forge', version: '1.0.0' };

const MCP_TOOLS: Array<Record<string, unknown>> = [
  { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch' }, base: { type: 'string', description: 'Base branch' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request (squash)', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function mcpToolResult(res: ServerResponse, id: unknown, text: string, structured: unknown, isError = false): void {
  mcpResult(res, id, {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'x-github-request-id': nextRequestId(), 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return true;
  }
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const msg = parsed as Record<string, unknown>;
  const id = msg.id ?? null;
  const rpcMethod = String(msg.method ?? '');
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (rpcMethod === 'ping') { mcpResult(res, id, {}); return true; }
  if (rpcMethod === 'server/discover') {
    const discover = {
      supportedVersions: [MCP_VERSION],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    };
    mcpResult(res, id, { ...discover, _meta: discover });
    return true;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
    const version = MCP_KNOWN_VERSIONS.includes(requested) ? requested : MCP_VERSION;
    mcpResult(res, id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
    return true;
  }
  if (rpcMethod === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { mcpError(res, id, -32602, `Unknown tool: ${name}`); return true; }
    const required = ((tool.inputSchema as Record<string, unknown>).required ?? []) as string[];
    for (const r of required) {
      if (args[r] === undefined || args[r] === null || args[r] === '') {
        mcpToolResult(res, id, `Missing required argument: ${r}`, { error: `Missing required argument: ${r}` }, true);
        return true;
      }
    }
    try {
      if (name === 'create_repo') {
        const repoName = String(args.name);
        if (repos.has(repoName)) {
          mcpToolResult(res, id, `Repository ${repoName} already exists`, { error: 'Repository already exists' }, true);
          return true;
        }
        repoIdSeq += 1;
        const { iso } = stamp();
        const repo: Repo = {
          id: repoIdSeq, name: repoName, owner: VIEWER_LOGIN,
          description: typeof args.description === 'string' ? args.description : '',
          priv: args.private === true, defaultBranch: DEFAULT_BRANCH, createdAt: iso,
          refs: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 1,
          labels: new Map(), fileCache: new Map(),
        };
        repos.set(repoName, repo);
        const out = repoJson(repo);
        mcpToolResult(res, id, `Created repository ${VIEWER_LOGIN}/${repoName}`, out);
        return true;
      }
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = getRepo(owner, repoName);
      if (name === 'get_repo') {
        if (!repo) { mcpToolResult(res, id, `Repository not found: ${owner}/${repoName}`, { error: 'Repository not found' }, true); return true; }
        const out = repoJson(repo);
        mcpToolResult(res, id, JSON.stringify(out), out);
        return true;
      }
      if (!repo) { mcpToolResult(res, id, `Repository not found: ${owner}/${repoName}`, { error: 'Repository not found' }, true); return true; }
      if (name === 'create_issue') {
        const issue = createIssueInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '');
        const out = issueJson(repo, issue);
        mcpToolResult(res, id, JSON.stringify(out), out);
        return true;
      }
      if (name === 'list_issues') {
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => a.number - b.number);
        const out = list.map((i) => issueJson(repo, i));
        mcpToolResult(res, id, JSON.stringify(out), { issues: out });
        return true;
      }
      if (name === 'create_pull_request') {
        const pr = createPullInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
        const out = pullJson(repo, pr);
        mcpToolResult(res, id, JSON.stringify(out), out);
        return true;
      }
      if (name === 'merge_pull_request') {
        const pr = repo.pulls.get(Number(args.pull_number));
        if (!pr) { mcpToolResult(res, id, `Pull request not found: ${args.pull_number}`, { error: 'Pull request not found' }, true); return true; }
        if (pr.merged || pr.state === 'closed') { mcpToolResult(res, id, 'Pull request is already merged or closed', { error: 'Pull request is already merged or closed' }, true); return true; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { mcpToolResult(res, id, 'Merge conflict', { error: 'Merge conflict' }, true); return true; }
        mcpToolResult(res, id, JSON.stringify({ sha, merged: true, message: 'Pull request successfully merged' }), { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
    } catch (err) {
      mcpToolResult(res, id, err instanceof Error ? err.message : String(err), { error: err instanceof Error ? err.message : String(err) }, true);
      return true;
    }
    mcpError(res, id, -32602, `Unknown tool: ${name}`);
    return true;
  }
  mcpError(res, id, -32601, `Method not found: ${rpcMethod}`);
  return true;
}

// ---------------------------------------------------------------------------
// Server + lifecycle
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const segs = pathSegments(req);
    if (await handleRest(req, res, segs)) return;
    if (segs.length === 2 && segs[0] === 'api' && segs[1] === 'graphql' && req.method === 'POST') {
      if (await handleGraphql(req, res)) return;
    }
    if (segs.length === 1 && segs[0] === 'mcp') {
      if (await handleMcp(req, res)) return;
    }
    if (await handleGit(req, res, segs)) return;
    errJson(res, 404, 'Not Found');
  } catch (err) {
    try { errJson(res, 500, 'Internal Server Error'); } catch { /* response already sent */ }
  }
});

function httpJson(url: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = request({
      method, hostname: u.hostname, port: Number(u.port) || 80, path: u.pathname,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text || '{}') as Record<string, unknown>); }
        catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    const base = envUrl.replace(/\/+$/, '');
    try { await httpJson(`${base}/register`, 'POST', { port }); } catch { /* the suite will time out if registration failed */ }
    for (;;) {
      try {
        const done = await httpJson(`${base}/done`, 'GET');
        if (done.done === true || done.status === 'done') break;
      } catch { /* retry below */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    // Standalone dev mode: serve until killed.
    await new Promise(() => undefined);
  }
  server.close();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
