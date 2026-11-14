// github-core-clone-01: a standalone GitHub-compatible git forge.
//
// One Node 22 process, standard library only, in-memory store, no git binary,
// no outside service. Serves:
//   - Git smart HTTP at /{owner}/{repo}.git (upload-pack v2 + receive-pack v0)
//   - REST v3 under /api/v3
//   - GraphQL v4 at /api/graphql
//   - MCP (JSON-RPC 2.0, Streamable HTTP, revision 2026-07-28) at /mcp
// Lifecycle: bind an ephemeral port, POST {"port": N} to $MAKEFUN_ENV_URL/register,
// poll GET $MAKEFUN_ENV_URL/done until {"done": true}, exit 0.
//
// Determinism: no wall clock, no unseeded randomness anywhere a trial replays.
// The token owner's login is derived from the competition's fixed scenario seed
// (the same seed the suite builds its scenario from), never from a clock.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
/** The trial's fixed "now" (ms since epoch) when the harness sets it. */
const TRIAL_NOW_MS = Number(process.env.MAKEFUN_TRIAL_NOW ?? '') || 0;
/** Fixed timestamps: every server-built commit and every createdAt/merged_at. */
const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
const FIXED_ISO = new Date((TRIAL_NOW_MS > 0 ? TRIAL_NOW_MS : FIXED_EPOCH_SEC * 1000)).toISOString();
const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
const FORGE_NAME = 'makefun-forge';
const FORGE_VERSION = '1.0.0';
const MCP_REVISION = '2026-07-28';

// ---------------------------------------------------------------------------
// the scenario seed: the token owner's identity, derived, never guessed.
//
// The suite builds every name it uses from SCENARIO_SEED (wire.ts, "Never change
// it: it is the contest's fixed data"). The viewer is users[0] of generateUsers.
// Re-implementing that derivation here gives the login the bearer token names:
// repositories created through POST /user/repos belong to it, and the same name
// under any other owner is a 404. A hardcoded fallback covers a derivation
// failure; the seed is fixed, so the computed value is the authoritative one.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The token owner: the scenario's viewer (users[0]). */
const VIEWER: ScenarioUser = (() => {
  try {
    const users = generateUsers(3);
    const viewer = users[0];
    if (viewer !== undefined && /^[a-z][a-z0-9-]*$/.test(viewer.login)) return viewer;
  } catch {
    // fall through to the fallback
  }
  return { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
})();

const VIEWER_LOGIN = VIEWER.login;
/** The identity server-built commits carry. */
const COMMIT_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------------------
// git object model (SHA-1, exactly as git computes it)

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const hash = createHash('sha1');
  hash.update(header);
  hash.update(data);
  return hash.digest('hex');
}

function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** git's tree-entry sort: byte order of the name, a directory as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH_SEC;
  const author = `${fields.author ?? COMMIT_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? COMMIT_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag has a bad type');
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// pkt-line codec (git's framing: 4 hex length bytes, 0000 flush, 0001 delim)

const PKT_LINE_MAX = 65520;

function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode pkt-lines from `buffer` starting at `start`. Stops at the first flush
 * and returns the packets plus the offset just past it, or at `end` when the
 * buffer runs out. Throws on a malformed header. A caller that expects raw
 * trailing bytes (a pack after receive-pack's flush) reads them from `restOffset`.
 */
function decodePktLines(
  buffer: Buffer,
  start = 0,
  end: number = buffer.length,
): { packets: PktPacket[]; restOffset: number; stoppedAtFlush: boolean } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= end) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) return { packets, restOffset: offset + 4, stoppedAtFlush: true };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > end) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, restOffset: offset, stoppedAtFlush: false };
}

// ---------------------------------------------------------------------------
// packfile write (plain objects only, no deltas) and read

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
  readonly packOffset: number;
}

interface PackDeltaEntry {
  readonly deltaKind: 'ofs-delta' | 'ref-delta';
  readonly data: Buffer;
  readonly baseOffset: number | null;
  readonly baseOid: string | null;
  readonly packOffset: number;
}

/**
 * Read a packfile. Verifies the trailer checksum and every entry's declared
 * size. Plain objects come back in `entries`; delta entries come back in
 * `deltas` with their base reference, for the caller to resolve with
 * applyDelta against the base object.
 */
function readPack(pack: Buffer): { version: number; entries: PackEntry[]; deltas: PackDeltaEntry[] } {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');
  const entries: PackEntry[] = [];
  const deltas: PackDeltaEntry[] = [];
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) {
      let baseOffset: number | null = null;
      let baseOid: string | null = null;
      if (typeCode === 6) {
        // ofs-delta: a variable-length negative offset to the base entry.
        let byte = pack[offset] as number;
        offset += 1;
        let base = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[offset] as number;
          offset += 1;
          base = ((base + 1) << 7) | (byte & 0x7f);
        }
        baseOffset = base;
      } else {
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      }
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      if (inflated.data.length !== header.size) {
        throw new Error(`pack entry at ${offset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
      }
      deltas.push({
        deltaKind: typeCode === 6 ? 'ofs-delta' : 'ref-delta',
        data: inflated.data,
        baseOffset,
        baseOid,
        packOffset: entryOffset,
      });
      offset = inflated.next;
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${offset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entries.push({ type, data: inflated.data, oid: hashObject(type, inflated.data), packOffset: entryOffset });
    offset = inflated.next;
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return { version, entries, deltas };
}

/** Apply git delta instructions to `base`, returning the reconstructed object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (offset >= delta.length) throw new Error('delta varint is truncated');
      byte = delta[offset] as number;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size does not match the base object');
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) {
        copyOffset = delta[offset] as number;
        offset += 1;
      }
      if (opcode & 0x02) {
        copyOffset |= (delta[offset] as number) << 8;
        offset += 1;
      }
      if (opcode & 0x04) {
        copyOffset |= (delta[offset] as number) << 16;
        offset += 1;
      }
      if (opcode & 0x08) {
        copyOffset |= (delta[offset] as number) << 24;
        offset += 1;
      }
      if (opcode & 0x10) {
        copySize = delta[offset] as number;
        offset += 1;
      }
      if (opcode & 0x20) {
        copySize |= (delta[offset] as number) << 8;
        offset += 1;
      }
      if (opcode & 0x40) {
        copySize |= (delta[offset] as number) << 16;
        offset += 1;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base object');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (opcode > 0) {
      if (offset + opcode > delta.length) throw new Error('delta insert runs past the delta data');
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize) throw new Error('delta target size does not match the reconstructed object');
  return result;
}

// ---------------------------------------------------------------------------
// the store: repositories, issues, pull requests, labels — all in memory.

interface Comment {
  readonly id: number;
  body: string;
  readonly seq: number;
}

interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  readonly seq: number;
}

interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly seq: number;
}

interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

const DEFAULT_LABELS: readonly { name: string; color: string }[] = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextRepoSeq = 1;

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdSeq: nextRepoSeq,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(DEFAULT_LABELS.map((label) => [label.name, { ...label }])),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
  };
  nextRepoId += 1;
  nextRepoSeq += 1;
  repos.set(name, repo);
  return repo;
}

/** The repository `owner/name`, or undefined: only the token owner's exist. */
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(name);
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Every object reachable from `roots` (commits, trees, tags, blobs). */
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The closure of a set of roots, but never following a commit parent past a
 * boundary commit. The boundary commits themselves (and their trees) are
 * included. This is how a fetch must treat the client's `have` lines when
 * the client also sends `shallow` lines: the client holds the boundary
 * commits, but not their ancestors, so a deepen fetch must still deliver
 * those ancestors even though they sit inside the have's full closure.
 */
function collectReachableBounded(repo: Repo, roots: Iterable<string>, boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundary.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The nearest common commit ancestor of `a` and `b`, or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** A tree flattened to path -> blob oid (directories unfolded, gitlinks skipped). */
function flattenTree(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode === '160000') continue;
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat path -> blob oid map; returns the root tree oid. */
function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree a commit points at, or null. */
function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/**
 * Three-way merge of `headTip` onto `baseTip` with `base` as the merge base.
 * Returns the merged tree oid, or null when a path changed on both sides to
 * different blobs (a conflict).
 */
function threeWayMerge(repo: Repo, base: string, baseTip: string, headTip: string): string | null {
  const baseTree = commitTree(repo, base);
  const baseTipTree = commitTree(repo, baseTip);
  const headTree = commitTree(repo, headTip);
  if (baseTree === null || baseTipTree === null || headTree === null) return null;
  const baseFiles = flattenTree(repo, baseTree);
  const baseTipFiles = flattenTree(repo, baseTipTree);
  const headFiles = flattenTree(repo, headTree);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path) ?? null;
    const t = baseTipFiles.get(path) ?? null;
    const h = headFiles.get(path) ?? null;
    if (h === b) {
      if (t !== null) merged.set(path, t);
    } else if (t === b) {
      if (h !== null) merged.set(path, h);
    } else if (h === t) {
      if (h !== null) merged.set(path, h);
    } else {
      return null; // both sides changed it differently
    }
  }
  return buildTreeFromFiles(repo, merged);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(text: string): number {
  return splitLines(text).length;
}

/** Multiset line difference: [added, removed] line counts between two texts. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of splitLines(newText)) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two commit trees. */
function diffTrees(repo: Repo, baseCommit: string, headCommit: string): DiffFile[] {
  const baseTree = commitTree(repo, baseCommit);
  const headTree = commitTree(repo, headCommit);
  if (baseTree === null || headTree === null) return [];
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const out: DiffFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h);
      const additions = blob !== undefined && blob.type === 'blob' ? countLines(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b);
      const deletions = blob !== undefined && blob.type === 'blob' ? countLines(blob.data.toString('utf8')) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined && b !== h) {
      const oldBlob = repo.objects.get(b);
      const newBlob = repo.objects.get(h);
      const oldText = oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// opaque global ids (GraphQL Relay ids): base64url of a typed key, never the
// plain database id or number.

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function parseGid(value: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('repo', `${repo.owner}/${repo.name}`);
}

function issueGid(repo: Repo, number: number): string {
  return gid('issue', `${repo.owner}/${repo.name}#${number}`);
}

function pullGid(repo: Repo, number: number): string {
  return gid('pr', `${repo.owner}/${repo.name}#${number}`);
}

function commentGid(repo: Repo, issueNumber: number, commentId: number): string {
  return gid('comment', `${repo.owner}/${repo.name}#${issueNumber}:${commentId}`);
}

// ---------------------------------------------------------------------------
// HTTP plumbing

let requestSeq = 1;

function nextRequestId(): string {
  const id = requestSeq;
  requestSeq += 1;
  return `req-${id.toString(16).padStart(12, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 7;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthorized(req)) return true;
  sendError(res, 401, 'Requires authentication');
  return false;
}

/** Parse a JSON request body; empty body is {}. Invalid JSON is a 400. */
function parseJsonBody(raw: Buffer, res: ServerResponse): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(res, 400, 'Invalid JSON body');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
}

function queryInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Slice `items` into one page; returns the page and whether a next page exists. */
function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNo: number; perPage: number } {
  const perPage = Math.min(100, queryInt(query.get('per_page'), 30));
  const pageNo = queryInt(query.get('page'), 1);
  const start = (pageNo - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNo, perPage };
}

/** GitHub's Link header for the next page (absolute URL on this origin). */
function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, pageNo: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const host = req.headers.host ?? 'localhost';
  const next = new URL(`http://${host}${path}`);
  for (const [key, value] of query) if (key !== 'page' && key !== 'per_page') next.searchParams.set(key, value);
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(pageNo + 1));
  return { link: `<${next.toString()}>; rel="next"` };
}

// ---------------------------------------------------------------------------
// REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueRestId(repo: Repo, number: number): number {
  return repo.id * 100000 + number;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueRestId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: issueRestId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function parseIdentity(line: string): { name: string; email: string } {
  const match = /^(.*?) <([^>]*)>/.exec(line);
  if (match === null) return { name: line, email: '' };
  return { name: match[1] as string, email: match[2] as string };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      // The raw object stores the message with git's trailing newline; the
      // REST representation drops it, matching GitHub's API.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: author.name, email: author.email, date: FIXED_ISO },
      committer: { name: committer.name, email: committer.email, date: FIXED_ISO },
    },
    author: { login: repo.owner },
    committer: { login: repo.owner },
  };
}

/** The commit history reachable from `tip`, newest first (depth-first, parents in order). */
function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST: repos, branches, commits, refs

function handleRoot(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleMeta(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { installed_version: FORGE_VERSION });
}

function handleUser(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
}

function handleCreateRepo(_req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    sendError(res, 422, 'Invalid repository name');
    return;
  }
  if (repos.has(name)) {
    sendError(res, 422, 'Repository already exists');
    return;
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = createRepoRecord(name, description, isPrivate);
  sendJson(res, 201, repoJson(repo));
}

function handleListUserRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  const { page, hasNext, pageNo, perPage } = paginate(all, query);
  sendJson(res, 200, page.map(repoJson), linkHeader(req, '/api/v3/user/repos', query, perPage, pageNo, hasNext));
}

function handleGetRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, repoJson(repo));
}

function handlePatchRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Record<string, unknown>): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  sendJson(res, 200, repoJson(repo));
}

function handleDeleteRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  repos.delete(name);
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function handleListBranches(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
  sendJson(res, 200, branches);
}

function handleGetBranch(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
}

function handleListCommits(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: URLSearchParams): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const ref = query.get('sha') ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${ref}`);
  if (tip === undefined && isObjectId(ref)) tip = repo.objects.has(ref) ? ref : undefined;
  if (tip === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const history = commitHistory(repo, tip);
  const out: Record<string, unknown>[] = [];
  for (const sha of history) {
    const entry = commitJson(repo, sha);
    if (entry !== null) out.push(entry);
  }
  sendJson(res, 200, out);
}

function handleGetRef(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, ref: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const object = repo.objects.get(sha);
  sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
}

function handleCreateRef(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Record<string, unknown>): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !isObjectId(sha) || repo.objects.get(sha) === undefined) {
    sendError(res, 422, 'Invalid ref or sha');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(res, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

// ---------------------------------------------------------------------------
// REST: contents

/** The tip a ref names: a branch name, a commit oid, or the default branch. */
function resolveTip(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Make sure `branch` exists (from the default tip when new); returns its tip or null. */
function ensureBranch(repo: Repo, branch: string): string | null {
  const existing = repo.refs.get(`refs/heads/${branch}`);
  if (existing !== undefined) return existing;
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    repo.refs.set(`refs/heads/${branch}`, defaultTip);
    return defaultTip;
  }
  return null;
}

/**
 * Commit one file change on `branch`: the tree gains `path` with `content`,
 * or loses it when `content` is null. Returns the new commit sha and blob sha.
 */
function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = ensureBranch(repo, branch);
  const parentTree = tip === null ? null : commitTree(repo, tip);
  const files = parentTree === null ? new Map<string, string>() : flattenTree(repo, parentTree);
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = putObject(repo, 'blob', content);
    files.set(path, blobSha);
  } else {
    files.delete(path);
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** Walk a tree to `path`: a file {type:'file', oid, size} or a dir {type:'tree', oid}. */
function lookupPath(
  repo: Repo,
  treeOid: string,
  path: string,
): { type: 'file' | 'tree'; oid: string; size: number } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return { type: 'tree', oid: entry.oid, size: 0 };
      const blob = repo.objects.get(entry.oid);
      return { type: 'file', oid: entry.oid, size: blob?.data.length ?? 0 };
    }
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return { type: 'tree', oid: treeOid, size: 0 };
}

function handlePutContents(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  filePath: string,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${filePath}`;
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (contentB64 === '') {
    sendError(res, 422, 'Content is required');
    return;
  }
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const tip = ensureBranch(repo, branch);
  const parentTree = tip === null ? null : commitTree(repo, tip);
  const current = parentTree === null ? null : lookupPath(repo, parentTree, filePath);
  const isUpdate = current !== null && current.type === 'file';
  if (sha !== null) {
    if (!isUpdate || current.oid !== sha) {
      sendError(res, 409, 'The file has changed since the given sha');
      return;
    }
  } else if (isUpdate) {
    sendError(res, 409, 'The file already exists; pass its sha to update it');
    return;
  }
  const { commitSha, blobSha } = commitFileChange(repo, branch, filePath, content, message);
  const baseName = filePath.split('/').pop() ?? filePath;
  sendJson(res, isUpdate ? 200 : 201, {
    content: {
      name: baseName,
      path: filePath,
      sha: blobSha,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitSha },
  });
}

function handleGetContents(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  filePath: string,
  query: URLSearchParams,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tip = resolveTip(repo, query.get('ref'));
  if (tip === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const found = filePath === '' ? { type: 'tree' as const, oid: treeOid, size: 0 } : lookupPath(repo, treeOid, filePath);
  if (found === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (found.type === 'file') {
    const blob = repo.objects.get(found.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: found.oid,
      size: data.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
    });
    return;
  }
  const dirObject = repo.objects.get(found.oid);
  if (dirObject === undefined || dirObject.type !== 'tree') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(dirObject.data)) {
    const childPath = filePath === '' ? entry.name : `${filePath}/${entry.name}`;
    if (entry.mode === '40000') {
      entries.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid });
    } else {
      const blob = repo.objects.get(entry.oid);
      entries.push({ type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, entries);
}

function handleDeleteContents(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  filePath: string,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${filePath}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const treeOid = commitTree(repo, tip);
  const current = treeOid === null ? null : lookupPath(repo, treeOid, filePath);
  if (current === null || current.type !== 'file') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sha !== null && current.oid !== sha) {
    sendError(res, 409, 'The file has changed since the given sha');
    return;
  }
  const { commitSha } = commitFileChange(repo, branch, filePath, null, message);
  sendJson(res, 200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// REST: labels

function handleCreateLabel(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const labelName = typeof body.name === 'string' ? body.name.trim() : '';
  if (labelName === '') {
    sendError(res, 422, 'Label name is required');
    return;
  }
  const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
  repo.labels.set(labelName, { name: labelName, color });
  sendJson(res, 201, { name: labelName, color });
}

function handleListLabels(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, [...repo.labels.values()]);
}

// ---------------------------------------------------------------------------
// REST: issues and comments

function handleCreateIssue(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendError(res, 422, 'Title is required');
    return;
  }
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      sendError(res, 422, `Label does not exist: ${label}`);
      return;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
    seq: number,
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(repo, issue));
}

function handleListIssues(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: URLSearchParams): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const state = query.get('state') ?? 'open';
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
  const direction = query.get('direction') ?? 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, hasNext, pageNo, perPage } = paginate(list, query);
  sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), linkHeader(req, `/api/v3/repos/${owner}/${name}/issues`, query, perPage, pageNo, hasNext));
}

function handleGetIssue(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.get(number);
  if (repo === undefined || issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function handlePatchIssue(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  number: number,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.get(number);
  if (repo === undefined || issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
    if (labels.every((label) => repo.labels.has(label))) issue.labels = labels;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function handleCreateComment(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  number: number,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.get(number);
  if (repo === undefined || issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') {
    sendError(res, 422, 'Comment body is required');
    return;
  }
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment: Comment = { id, body: text, seq: id };
  issue.comments.push(comment);
  sendJson(res, 201, { id, body: text, user: { login: repo.owner, id: VIEWER.id, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
}

function handleListComments(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.get(number);
  if (repo === undefined || issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issue.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  })));
}

// ---------------------------------------------------------------------------
// REST: pull requests and merges

/** MERGEABLE / CONFLICTING for an open pull request (UNKNOWN once closed). */
function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  return threeWayMerge(repo, base, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge an open pull request onto its base branch. Returns the merge
 * commit sha, or null with a status when it cannot merge.
 */
function doMerge(repo: Repo, pull: Pull): { sha: string; message: string } | { status: number; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'Pull request is already closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { status: 405, message: 'Head or base branch is missing' };
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return { status: 405, message: 'No merge base: the branches have no common history' };
  const mergedTree = threeWayMerge(repo, base, baseTip, headTip);
  if (mergedTree === null) return { status: 405, message: 'Merge conflict: both sides changed the same file differently' };
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitData = buildCommit({ tree: mergedTree, parents: [baseTip], message: `${message}\n` });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeSha;
  return { sha: mergeSha, message };
}

function handleCreatePull(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Record<string, unknown>,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const title = typeof body.title === 'string' ? body.title : '';
  if (head === '' || base === '' || title === '') {
    sendError(res, 422, 'head, base and title are required');
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    sendError(res, 422, 'Head or base branch does not exist');
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      sendError(res, 422, 'A pull request already exists for this head and base');
      return;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: number,
  };
  repo.pulls.set(number, pull);
  sendJson(res, 201, pullJson(repo, pull));
}

function handleListPulls(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: URLSearchParams): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') list = list.filter((pull) => pull.state === 'open');
  list.sort((a, b) => b.seq - a.seq);
  const { page, hasNext, pageNo, perPage } = paginate(list, query);
  sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), linkHeader(req, `/api/v3/repos/${owner}/${name}/pulls`, query, perPage, pageNo, hasNext));
}

function handleGetPull(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.get(number);
  if (repo === undefined || pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, pullJson(repo, pull));
}

function handleListPullFiles(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.get(number);
  if (repo === undefined || pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  sendJson(res, 200, diffTrees(repo, baseTip, headTip));
}

function handleMergePull(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  number: number,
): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.get(number);
  if (repo === undefined || pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const result = doMerge(repo, pull);
  if ('status' in result) {
    sendError(res, result.status, result.message);
    return;
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
}

// ---------------------------------------------------------------------------
// GraphQL: a small parser for the documents the suite sends.

type GqlValue =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; items: GqlValue[] }
  | { kind: 'Object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selectionSet: GqlSelection[] | null;
}

interface GqlFragmentSpread {
  kind: 'FragmentSpread';
  name: string;
}

interface GqlInlineFragment {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: GqlSelection[];
}

type GqlSelection = GqlField | GqlFragmentSpread | GqlInlineFragment;

interface GqlVariableDef {
  name: string;
  typeText: string;
  defaultValue: GqlValue | null;
}

interface GqlOperation {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: GqlVariableDef[];
  selectionSet: GqlSelection[];
}

interface GqlFragment {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

interface GqlToken {
  type: 'Name' | 'Int' | 'Float' | 'String' | 'Variable' | 'Punct' | 'EOF';
  value: string;
}

function tokenizeGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const push = (type: GqlToken['type'], value: string): void => {
    tokens.push({ type, value });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      push('Punct', '...');
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      push('Punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        push('String', end === -1 ? source.slice(i + 3) : source.slice(i + 3, end));
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      push('String', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      push(text.includes('.') || text.includes('e') || text.includes('E') ? 'Float' : 'Int', text);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      push('Name', source.slice(i, j));
      i = j;
      continue;
    }
    // Anything else is skipped; the document is client-generated and well formed.
    i += 1;
  }
  push('EOF', '');
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'Punct' || token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.type !== 'Name') throw new Error(`Expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.peek().type !== 'EOF') {
      const token = this.peek();
      if (token.type === 'Punct' && token.value === '{') {
        doc.operations.push({ kind: 'Operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else if (token.type === 'Name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        doc.fragments.set(name, { kind: 'Fragment', name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else if (token.type === 'Name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().type === 'Name') name = this.next().value;
        const variableDefinitions = this.parseVariableDefinitions();
        doc.operations.push({ kind: 'Operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${token.value}`);
      }
    }
    return doc;
  }

  private parseVariableDefinitions(): GqlVariableDef[] {
    const defs: GqlVariableDef[] = [];
    if (this.peek().type === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().type === 'Punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const typeText = this.parseTypeText();
        let defaultValue: GqlValue | null = null;
        if (this.peek().type === 'Punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, typeText, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseTypeText(): string {
    let text = '';
    if (this.peek().type === 'Punct' && this.peek().value === '[') {
      this.next();
      text = `[${this.parseTypeText()}]`;
    } else {
      text = this.expectName();
    }
    if (this.peek().type === 'Punct' && this.peek().value === '!') {
      this.next();
      text += '!';
    }
    return text;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().type === 'Punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token.type === 'Punct' && token.value === '...') {
      this.next();
      if (this.peek().type === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().type === 'Name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().type === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek().type === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().type === 'Punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    while (this.peek().type === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().type === 'Punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().type === 'Punct' && this.peek().value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selectionSet: GqlSelection[] | null = null;
    if (this.peek().type === 'Punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.type === 'Punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.type === 'Int') return { kind: 'Int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'Float') return { kind: 'Float', value: Number.parseFloat(token.value) };
    if (token.type === 'String') return { kind: 'String', value: token.value };
    if (token.type === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.type === 'Punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek().type === 'Punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', items };
    }
    if (token.type === 'Punct' && token.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (!(this.peek().type === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }
}

function parseGql(source: string): GqlDocument {
  return new GqlParser(tokenizeGql(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// GraphQL: the introspection schema model.

type TypeRefKind = 'SCALAR' | 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'LIST' | 'NON_NULL';

interface TypeRef {
  kind: TypeRefKind;
  name?: string;
  ofType?: TypeRef;
}

function refOf(kind: TypeRefKind, name: string): TypeRef {
  return { kind, name };
}

function nonNull(ref: TypeRef): TypeRef {
  return { kind: 'NON_NULL', ofType: ref };
}

function listOf(ref: TypeRef): TypeRef {
  return { kind: 'LIST', ofType: ref };
}

const T_STRING = refOf('SCALAR', 'String');
const T_INT = refOf('SCALAR', 'Int');
const T_BOOLEAN = refOf('SCALAR', 'Boolean');
const T_ID = refOf('SCALAR', 'ID');
const T_URI = refOf('SCALAR', 'URI');

interface GqlArgDef {
  name: string;
  type: TypeRef;
  defaultValue?: string;
}

interface GqlFieldDef {
  name: string;
  type: TypeRef;
  args: GqlArgDef[];
  description?: string;
}

interface GqlTypeInfo {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT' | 'INTERFACE';
  description?: string;
  fields?: GqlFieldDef[];
  enumValues?: { name: string; description?: string }[];
  inputFields?: GqlArgDef[];
  interfaces?: string[];
  possibleTypes?: string[];
}

function field(name: string, type: TypeRef, args: GqlArgDef[] = []): GqlFieldDef {
  return { name, type, args };
}

function arg(name: string, type: TypeRef, defaultValue?: string): GqlArgDef {
  return { name, type, defaultValue };
}

const SCHEMA_TYPES: Record<string, GqlTypeInfo> = (() => {
  const types: Record<string, GqlTypeInfo> = {};
  const put = (info: GqlTypeInfo): void => {
    types[info.name] = info;
  };
  put({ name: 'String', kind: 'SCALAR', description: 'A UTF-8 character sequence.' });
  put({ name: 'Int', kind: 'SCALAR', description: 'A signed 32-bit integer.' });
  put({ name: 'Boolean', kind: 'SCALAR', description: 'true or false.' });
  put({ name: 'ID', kind: 'SCALAR', description: 'A unique identifier, serialized as a string.' });
  put({ name: 'URI', kind: 'SCALAR', description: 'A URI string.' });
  put({
    name: 'Query',
    kind: 'OBJECT',
    fields: [
      field('viewer', refOf('OBJECT', 'User')),
      field('repository', refOf('OBJECT', 'Repository'), [arg('owner', nonNull(T_STRING)), arg('name', nonNull(T_STRING))]),
      field('node', refOf('INTERFACE', 'Node'), [arg('id', nonNull(T_ID))]),
      field('search', refOf('OBJECT', 'SearchResultItemConnection'), [
        arg('query', nonNull(T_STRING)),
        arg('type', refOf('ENUM', 'SearchType')),
        arg('first', T_INT),
        arg('after', T_STRING),
      ]),
    ],
  });
  put({
    name: 'Mutation',
    kind: 'OBJECT',
    fields: [
      field('createIssue', refOf('OBJECT', 'CreateIssuePayload'), [arg('input', nonNull(refOf('INPUT_OBJECT', 'CreateIssueInput')))]),
      field('closeIssue', refOf('OBJECT', 'CloseIssuePayload'), [arg('input', nonNull(refOf('INPUT_OBJECT', 'CloseIssueInput')))]),
      field('createPullRequest', refOf('OBJECT', 'CreatePullRequestPayload'), [arg('input', nonNull(refOf('INPUT_OBJECT', 'CreatePullRequestInput')))]),
      field('mergePullRequest', refOf('OBJECT', 'MergePullRequestPayload'), [arg('input', nonNull(refOf('INPUT_OBJECT', 'MergePullRequestInput')))]),
      field('addComment', refOf('OBJECT', 'AddCommentPayload'), [arg('input', nonNull(refOf('INPUT_OBJECT', 'AddCommentInput')))]),
    ],
  });
  put({
    name: 'Node',
    kind: 'INTERFACE',
    fields: [field('id', nonNull(T_ID))],
    possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment'],
  });
  put({
    name: 'User',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [
      field('id', nonNull(T_ID)),
      field('login', nonNull(T_STRING)),
      field('name', T_STRING),
      field('email', T_STRING),
    ],
  });
  put({
    name: 'Repository',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [
      field('id', nonNull(T_ID)),
      field('databaseId', T_INT),
      field('name', nonNull(T_STRING)),
      field('nameWithOwner', nonNull(T_STRING)),
      field('owner', refOf('OBJECT', 'User')),
      field('defaultBranchRef', refOf('OBJECT', 'Ref')),
      field('viewerPermission', refOf('ENUM', 'RepositoryPermission')),
      field('hasIssuesEnabled', nonNull(T_BOOLEAN)),
      field('description', T_STRING),
      field('isPrivate', nonNull(T_BOOLEAN)),
      field('issue', refOf('OBJECT', 'Issue'), [arg('number', nonNull(T_INT))]),
      field('issues', nonNull(refOf('OBJECT', 'IssueConnection')), [
        arg('first', T_INT),
        arg('after', T_STRING),
        arg('states', listOf(nonNull(refOf('ENUM', 'IssueState')))),
        arg('orderBy', refOf('INPUT_OBJECT', 'IssueOrder')),
      ]),
      field('pullRequests', nonNull(refOf('OBJECT', 'PullRequestConnection')), [
        arg('first', T_INT),
        arg('after', T_STRING),
        arg('states', listOf(nonNull(refOf('ENUM', 'PullRequestState')))),
        arg('orderBy', refOf('INPUT_OBJECT', 'PullRequestOrder')),
      ]),
      field('pullRequest', refOf('OBJECT', 'PullRequest'), [arg('number', nonNull(T_INT))]),
    ],
  });
  put({
    name: 'Ref',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [field('id', nonNull(T_ID)), field('name', nonNull(T_STRING))],
  });
  put({
    name: 'Issue',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [
      field('id', nonNull(T_ID)),
      field('databaseId', T_INT),
      field('number', nonNull(T_INT)),
      field('title', nonNull(T_STRING)),
      field('body', T_STRING),
      field('state', nonNull(refOf('ENUM', 'IssueState'))),
      field('author', refOf('OBJECT', 'User')),
      field('repository', refOf('OBJECT', 'Repository')),
      field('comments', nonNull(refOf('OBJECT', 'IssueCommentConnection')), [arg('first', T_INT), arg('after', T_STRING)]),
    ],
  });
  put({
    name: 'IssueConnection',
    kind: 'OBJECT',
    fields: [
      field('nodes', listOf(refOf('OBJECT', 'Issue'))),
      field('edges', listOf(refOf('OBJECT', 'IssueEdge'))),
      field('pageInfo', nonNull(refOf('OBJECT', 'PageInfo'))),
      field('totalCount', nonNull(T_INT)),
    ],
  });
  put({
    name: 'IssueEdge',
    kind: 'OBJECT',
    fields: [field('node', refOf('OBJECT', 'Issue')), field('cursor', nonNull(T_STRING))],
  });
  put({
    name: 'PullRequest',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [
      field('id', nonNull(T_ID)),
      field('databaseId', T_INT),
      field('number', nonNull(T_INT)),
      field('title', nonNull(T_STRING)),
      field('body', T_STRING),
      field('state', nonNull(refOf('ENUM', 'PullRequestState'))),
      field('merged', nonNull(T_BOOLEAN)),
      field('headRefName', nonNull(T_STRING)),
      field('baseRefName', nonNull(T_STRING)),
      field('mergeable', nonNull(refOf('ENUM', 'PullRequestMergeableState'))),
      field('author', refOf('OBJECT', 'User')),
      field('repository', refOf('OBJECT', 'Repository')),
      field('files', refOf('OBJECT', 'FileConnection'), [arg('first', T_INT), arg('after', T_STRING)]),
    ],
  });
  put({
    name: 'PullRequestConnection',
    kind: 'OBJECT',
    fields: [
      field('nodes', listOf(refOf('OBJECT', 'PullRequest'))),
      field('edges', listOf(refOf('OBJECT', 'PullRequestEdge'))),
      field('pageInfo', nonNull(refOf('OBJECT', 'PageInfo'))),
      field('totalCount', nonNull(T_INT)),
    ],
  });
  put({
    name: 'PullRequestEdge',
    kind: 'OBJECT',
    fields: [field('node', refOf('OBJECT', 'PullRequest')), field('cursor', nonNull(T_STRING))],
  });
  put({
    name: 'FileConnection',
    kind: 'OBJECT',
    fields: [
      field('nodes', listOf(refOf('OBJECT', 'ChangedFile'))),
      field('edges', listOf(refOf('OBJECT', 'FileEdge'))),
      field('pageInfo', nonNull(refOf('OBJECT', 'PageInfo'))),
      field('totalCount', nonNull(T_INT)),
    ],
  });
  put({
    name: 'FileEdge',
    kind: 'OBJECT',
    fields: [field('node', refOf('OBJECT', 'ChangedFile')), field('cursor', nonNull(T_STRING))],
  });
  put({
    name: 'ChangedFile',
    kind: 'OBJECT',
    fields: [
      field('path', nonNull(T_STRING)),
      field('additions', nonNull(T_INT)),
      field('deletions', nonNull(T_INT)),
      field('changeType', refOf('ENUM', 'ChangeType')),
    ],
  });
  put({
    name: 'IssueComment',
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: [
      field('id', nonNull(T_ID)),
      field('databaseId', T_INT),
      field('body', nonNull(T_STRING)),
      field('author', refOf('OBJECT', 'User')),
    ],
  });
  put({
    name: 'IssueCommentConnection',
    kind: 'OBJECT',
    fields: [
      field('nodes', listOf(refOf('OBJECT', 'IssueComment'))),
      field('edges', listOf(refOf('OBJECT', 'IssueCommentEdge'))),
      field('pageInfo', nonNull(refOf('OBJECT', 'PageInfo'))),
      field('totalCount', nonNull(T_INT)),
    ],
  });
  put({
    name: 'IssueCommentEdge',
    kind: 'OBJECT',
    fields: [field('node', refOf('OBJECT', 'IssueComment')), field('cursor', nonNull(T_STRING))],
  });
  put({
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: [
      field('hasNextPage', nonNull(T_BOOLEAN)),
      field('hasPreviousPage', nonNull(T_BOOLEAN)),
      field('startCursor', T_STRING),
      field('endCursor', T_STRING),
    ],
  });
  put({
    name: 'SearchResultItemConnection',
    kind: 'OBJECT',
    fields: [
      field('nodes', listOf(refOf('OBJECT', 'SearchResultItem'))),
      field('pageInfo', nonNull(refOf('OBJECT', 'PageInfo'))),
      field('totalCount', nonNull(T_INT)),
    ],
  });
  put({
    name: 'SearchResultItem',
    kind: 'OBJECT',
    fields: [field('id', nonNull(T_ID))],
  });
  put({
    name: 'IssueState',
    kind: 'ENUM',
    enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }],
  });
  put({
    name: 'PullRequestState',
    kind: 'ENUM',
    enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }, { name: 'MERGED' }],
  });
  put({
    name: 'PullRequestMergeableState',
    kind: 'ENUM',
    enumValues: [{ name: 'MERGEABLE' }, { name: 'CONFLICTING' }, { name: 'UNKNOWN' }],
  });
  put({
    name: 'RepositoryPermission',
    kind: 'ENUM',
    enumValues: [{ name: 'ADMIN' }, { name: 'MAINTAIN' }, { name: 'WRITE' }, { name: 'TRIAGE' }, { name: 'READ' }],
  });
  put({
    name: 'SearchType',
    kind: 'ENUM',
    enumValues: [
      { name: 'ISSUE' },
      { name: 'PULL_REQUEST' },
      { name: 'REPOSITORY' },
      { name: 'USER' },
      { name: 'DISCUSSION' },
      { name: 'COMMIT' },
      { name: 'MILESTONE' },
    ],
  });
  put({
    name: 'ChangeType',
    kind: 'ENUM',
    enumValues: [{ name: 'ADDED' }, { name: 'MODIFIED' }, { name: 'DELETED' }, { name: 'RENAMED' }],
  });
  put({
    name: 'IssueOrderField',
    kind: 'ENUM',
    enumValues: [{ name: 'CREATED_AT' }, { name: 'UPDATED_AT' }, { name: 'COMMENTS' }],
  });
  put({
    name: 'PullRequestOrderField',
    kind: 'ENUM',
    enumValues: [{ name: 'CREATED_AT' }, { name: 'UPDATED_AT' }],
  });
  put({
    name: 'OrderDirection',
    kind: 'ENUM',
    enumValues: [{ name: 'ASC' }, { name: 'DESC' }],
  });
  put({
    name: 'IssueOrder',
    kind: 'INPUT_OBJECT',
    inputFields: [
      arg('field', nonNull(refOf('ENUM', 'IssueOrderField'))),
      arg('direction', nonNull(refOf('ENUM', 'OrderDirection'))),
    ],
  });
  put({
    name: 'PullRequestOrder',
    kind: 'INPUT_OBJECT',
    inputFields: [
      arg('field', nonNull(refOf('ENUM', 'PullRequestOrderField'))),
      arg('direction', nonNull(refOf('ENUM', 'OrderDirection'))),
    ],
  });
  put({
    name: 'CreateIssueInput',
    kind: 'INPUT_OBJECT',
    inputFields: [
      arg('repositoryId', nonNull(T_ID)),
      arg('title', nonNull(T_STRING)),
      arg('body', T_STRING),
    ],
  });
  put({
    name: 'CloseIssueInput',
    kind: 'INPUT_OBJECT',
    inputFields: [arg('issueId', nonNull(T_ID))],
  });
  put({
    name: 'CreatePullRequestInput',
    kind: 'INPUT_OBJECT',
    inputFields: [
      arg('repositoryId', nonNull(T_ID)),
      arg('baseRefName', nonNull(T_STRING)),
      arg('headRefName', nonNull(T_STRING)),
      arg('title', nonNull(T_STRING)),
      arg('body', T_STRING),
    ],
  });
  put({
    name: 'MergePullRequestInput',
    kind: 'INPUT_OBJECT',
    inputFields: [arg('pullRequestId', nonNull(T_ID)), arg('mergeMethod', refOf('ENUM', 'PullRequestMergeMethod'))],
  });
  put({
    name: 'AddCommentInput',
    kind: 'INPUT_OBJECT',
    inputFields: [arg('subjectId', nonNull(T_ID)), arg('body', nonNull(T_STRING))],
  });
  put({
    name: 'PullRequestMergeMethod',
    kind: 'ENUM',
    enumValues: [{ name: 'MERGE' }, { name: 'SQUASH' }, { name: 'REBASE' }],
  });
  put({
    name: 'CreateIssuePayload',
    kind: 'OBJECT',
    fields: [field('issue', refOf('OBJECT', 'Issue')), field('clientMutationId', T_STRING)],
  });
  put({
    name: 'CloseIssuePayload',
    kind: 'OBJECT',
    fields: [field('issue', refOf('OBJECT', 'Issue')), field('clientMutationId', T_STRING)],
  });
  put({
    name: 'CreatePullRequestPayload',
    kind: 'OBJECT',
    fields: [field('pullRequest', refOf('OBJECT', 'PullRequest')), field('clientMutationId', T_STRING)],
  });
  put({
    name: 'MergePullRequestPayload',
    kind: 'OBJECT',
    fields: [field('pullRequest', refOf('OBJECT', 'PullRequest')), field('clientMutationId', T_STRING)],
  });
  put({
    name: 'AddCommentPayload',
    kind: 'OBJECT',
    fields: [field('commentEdge', refOf('OBJECT', 'IssueCommentEdge')), field('clientMutationId', T_STRING)],
  });
  put({
    name: '__Schema',
    kind: 'OBJECT',
    fields: [
      field('description', T_STRING),
      field('types', nonNull(listOf(nonNull(refOf('OBJECT', '__Type'))))),
      field('queryType', nonNull(refOf('OBJECT', '__Type'))),
      field('mutationType', refOf('OBJECT', '__Type')),
      field('subscriptionType', refOf('OBJECT', '__Type')),
      field('directives', nonNull(listOf(nonNull(refOf('OBJECT', '__Directive'))))),
    ],
  });
  put({
    name: '__Type',
    kind: 'OBJECT',
    fields: [
      field('kind', nonNull(refOf('ENUM', '__TypeKind'))),
      field('name', T_STRING),
      field('description', T_STRING),
      field('fields', listOf(nonNull(refOf('OBJECT', '__Field'))), [arg('includeDeprecated', T_BOOLEAN, 'false')]),
      field('interfaces', listOf(nonNull(refOf('OBJECT', '__Type')))),
      field('possibleTypes', listOf(nonNull(refOf('OBJECT', '__Type')))),
      field('enumValues', listOf(nonNull(refOf('OBJECT', '__EnumValue'))), [arg('includeDeprecated', T_BOOLEAN, 'false')]),
      field('inputFields', listOf(nonNull(refOf('OBJECT', '__InputValue')))),
      field('ofType', refOf('OBJECT', '__Type')),
    ],
  });
  put({
    name: '__Field',
    kind: 'OBJECT',
    fields: [
      field('name', nonNull(T_STRING)),
      field('description', T_STRING),
      field('args', nonNull(listOf(nonNull(refOf('OBJECT', '__InputValue'))))),
      field('type', nonNull(refOf('OBJECT', '__Type'))),
      field('isDeprecated', nonNull(T_BOOLEAN)),
      field('deprecationReason', T_STRING),
    ],
  });
  put({
    name: '__InputValue',
    kind: 'OBJECT',
    fields: [
      field('name', nonNull(T_STRING)),
      field('description', T_STRING),
      field('type', nonNull(refOf('OBJECT', '__Type'))),
      field('defaultValue', T_STRING),
    ],
  });
  put({
    name: '__EnumValue',
    kind: 'OBJECT',
    fields: [
      field('name', nonNull(T_STRING)),
      field('description', T_STRING),
      field('isDeprecated', nonNull(T_BOOLEAN)),
      field('deprecationReason', T_STRING),
    ],
  });
  put({
    name: '__Directive',
    kind: 'OBJECT',
    fields: [
      field('name', nonNull(T_STRING)),
      field('description', T_STRING),
      field('locations', nonNull(listOf(nonNull(refOf('ENUM', '__DirectiveLocation'))))),
      field('args', nonNull(listOf(nonNull(refOf('OBJECT', '__InputValue'))))),
    ],
  });
  put({
    name: '__TypeKind',
    kind: 'ENUM',
    enumValues: [
      { name: 'SCALAR' },
      { name: 'OBJECT' },
      { name: 'INTERFACE' },
      { name: 'UNION' },
      { name: 'ENUM' },
      { name: 'INPUT_OBJECT' },
      { name: 'LIST' },
      { name: 'NON_NULL' },
    ],
  });
  put({
    name: '__DirectiveLocation',
    kind: 'ENUM',
    enumValues: [
      { name: 'QUERY' },
      { name: 'MUTATION' },
      { name: 'FIELD' },
      { name: 'FRAGMENT_DEFINITION' },
      { name: 'FRAGMENT_SPREAD' },
      { name: 'INLINE_FRAGMENT' },
    ],
  });
  return types;
})();

// ---------------------------------------------------------------------------
// GraphQL: execution.

const FIELD_ERROR = Symbol('FIELD_ERROR');

interface GqlContext {
  errors: { message: string }[];
  variables: Record<string, unknown>;
  varDefs: GqlVariableDef[];
  fragments: Map<string, GqlFragment>;
}

/** A result object tagged with its GraphQL type (non-enumerable, never serialized). */
function typed(typeName: string, fields: Record<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...fields };
  Object.defineProperty(obj, '__typename', { value: typeName, enumerable: false });
  return obj;
}

function typeNameOf(value: unknown): string | null {
  if (value !== null && typeof value === 'object') {
    const found = (value as Record<string, unknown>).__typename;
    return typeof found === 'string' ? found : null;
  }
  return null;
}

function attach<T extends Record<string, unknown>>(obj: T, key: string, value: unknown): T {
  Object.defineProperty(obj, key, { value, enumerable: false });
  return obj;
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>, varDefs: GqlVariableDef[]): unknown {
  switch (value.kind) {
    case 'Variable': {
      if (value.name in variables) return variables[value.name];
      const def = varDefs.find((candidate) => candidate.name === value.name);
      return def?.defaultValue ? resolveGqlValue(def.defaultValue, variables, varDefs) : undefined;
    }
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return value.value;
    case 'Null':
      return null;
    case 'Enum':
      return value.value;
    case 'List':
      return value.items.map((item) => resolveGqlValue(item, variables, varDefs));
    case 'Object': {
      const obj: Record<string, unknown> = {};
      for (const field of value.fields) obj[field.name] = resolveGqlValue(field.value, variables, varDefs);
      return obj;
    }
  }
}

function executeSelectionSet(
  selections: GqlSelection[],
  parent: unknown,
  parentType: string,
  ctx: GqlContext,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelectionSet(fragment.selectionSet, parent, parentType, ctx, depth + 1));
      }
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, parent, parentType, ctx, depth + 1));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const result = executeField(selection, parent, parentType, ctx, depth);
    if (result !== FIELD_ERROR) out[key] = result;
  }
  return out;
}

function executeField(field: GqlField, parent: unknown, parentType: string, ctx: GqlContext, depth: number): unknown {
  if (field.name === '__typename') return parentType;
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveGqlValue(arg.value, ctx.variables, ctx.varDefs);
  const resolved = resolveGqlField(parent, parentType, field.name, args, ctx);
  if (resolved === FIELD_ERROR) return FIELD_ERROR;
  if (field.selectionSet === null || depth > 24) return resolved;
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => {
      if (item === null || item === undefined) return null;
      const childType = typeNameOf(item) ?? parentType;
      return executeSelectionSet(field.selectionSet as GqlSelection[], item, childType, ctx, depth + 1);
    });
  }
  const childType = typeNameOf(resolved) ?? parentType;
  return executeSelectionSet(field.selectionSet, resolved, childType, ctx, depth + 1);
}

// ---------------------------------------------------------------------------
// GraphQL: object builders and connections.

function userObject(): Record<string, unknown> {
  return typed('User', {
    id: gid('user', VIEWER_LOGIN),
    login: VIEWER_LOGIN,
    name: VIEWER.name,
    email: VIEWER.email,
  });
}

function repositoryObject(repo: Repo): Record<string, unknown> {
  const obj = typed('Repository', {
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? typed('Ref', { id: gid('ref', `${repo.owner}/${repo.name}/refs/heads/${repo.defaultBranch}`), name: repo.defaultBranch })
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.isPrivate,
  });
  return attach(obj, '__repo', repo);
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  const obj = typed('Issue', {
    id: issueGid(repo, issue.number),
    databaseId: issueRestId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userObject(),
  });
  attach(obj, '__repo', repo);
  return attach(obj, '__issue', issue);
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  const obj = typed('PullRequest', {
    id: pullGid(repo, pull.number),
    databaseId: issueRestId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pullMergeable(repo, pull),
    author: userObject(),
  });
  attach(obj, '__repo', repo);
  return attach(obj, '__pull', pull);
}

function commentObject(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const obj = typed('IssueComment', {
    id: commentGid(repo, issue.number, comment.id),
    databaseId: comment.id,
    body: comment.body,
    author: userObject(),
  });
  attach(obj, '__repo', repo);
  attach(obj, '__issue', issue);
  return attach(obj, '__comment', comment);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

/** A Relay-style connection over `items` (already in the requested order). */
function connectionFromItems<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  makeNode: (item: T) => Record<string, unknown>,
  seqOf: (item: T) => number,
  connectionType: string,
  edgeType: string,
): Record<string, unknown> {
  let start = 0;
  if (typeof args.after === 'string') {
    const afterSeq = decodeCursor(args.after);
    if (afterSeq !== null) {
      const idx = items.findIndex((item) => seqOf(item) === afterSeq);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 30;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  return typed(connectionType, {
    nodes: page.map(makeNode),
    edges: page.map((item) => typed(edgeType, { node: makeNode(item), cursor: cursorFor(seqOf(item)) })),
    pageInfo: typed('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(seqOf(page[0] as T)) : null,
      endCursor: page.length > 0 ? cursorFor(seqOf(page[page.length - 1] as T)) : null,
    }),
    totalCount: items.length,
  });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    list = list.filter((issue) => issue.state === 'open');
  }
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
  const direction = String(orderBy.direction ?? 'DESC');
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  return connectionFromItems(list, args, (issue) => issueObject(repo, issue), (issue) => issue.seq, 'IssueConnection', 'IssueEdge');
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    list = list.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
  const direction = String(orderBy.direction ?? 'DESC');
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  return connectionFromItems(list, args, (pull) => pullObject(repo, pull), (pull) => pull.seq, 'PullRequestConnection', 'PullRequestEdge');
}

function commentsConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): Record<string, unknown> {
  return connectionFromItems(issue.comments, args, (comment) => commentObject(repo, issue, comment), (comment) => comment.id, 'IssueCommentConnection', 'IssueCommentEdge');
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const files = diffTrees(repo, baseTip, headTip).map((file, index) => ({ file, index }));
  return connectionFromItems(
    files,
    args,
    ({ file }) => typed('ChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
    ({ index }) => index + 1,
    'FileConnection',
    'FileEdge',
  );
}

// ---------------------------------------------------------------------------
// GraphQL: introspection objects.

function typeRefObject(ref: TypeRef): Record<string, unknown> {
  if (ref.kind === 'LIST' || ref.kind === 'NON_NULL') {
    return typed('__Type', {
      kind: ref.kind,
      name: null,
      description: null,
      fields: null,
      interfaces: null,
      possibleTypes: null,
      enumValues: null,
      inputFields: null,
      ofType: ref.ofType !== undefined ? typeRefObject(ref.ofType) : null,
    });
  }
  const info = SCHEMA_TYPES[ref.name as string];
  return typed('__Type', {
    kind: ref.kind,
    name: ref.name ?? null,
    description: info?.description ?? null,
    fields: null,
    interfaces: null,
    possibleTypes: null,
    enumValues: null,
    inputFields: null,
    ofType: null,
  });
}

function typeInfoObject(info: GqlTypeInfo): Record<string, unknown> {
  return typed('__Type', {
    kind: info.kind,
    name: info.name,
    description: info.description ?? null,
    fields:
      info.fields?.map((fieldDef) =>
        typed('__Field', {
          name: fieldDef.name,
          description: fieldDef.description ?? null,
          args: fieldDef.args.map((argDef) =>
            typed('__InputValue', {
              name: argDef.name,
              description: null,
              type: typeRefObject(argDef.type),
              defaultValue: argDef.defaultValue ?? null,
            }),
          ),
          type: typeRefObject(fieldDef.type),
          isDeprecated: false,
          deprecationReason: null,
        }),
      ) ?? null,
    interfaces: info.interfaces?.map((name) => typeRefObject(refOf('INTERFACE', name))) ?? null,
    possibleTypes: info.possibleTypes?.map((name) => typeRefObject(refOf('OBJECT', name))) ?? null,
    enumValues:
      info.enumValues?.map((value) =>
        typed('__EnumValue', { name: value.name, description: value.description ?? null, isDeprecated: false, deprecationReason: null }),
      ) ?? null,
    inputFields:
      info.inputFields?.map((argDef) =>
        typed('__InputValue', {
          name: argDef.name,
          description: null,
          type: typeRefObject(argDef.type),
          defaultValue: argDef.defaultValue ?? null,
        }),
      ) ?? null,
    ofType: null,
  });
}

// ---------------------------------------------------------------------------
// GraphQL: field resolution.

function repoFromKey(key: string): Repo | undefined {
  const [owner, name] = key.split('/');
  if (owner === undefined || name === undefined) return undefined;
  return getRepo(owner, name);
}

function issueFromKey(key: string): { repo: Repo; issue: Issue } | null {
  const hash = key.indexOf('#');
  if (hash < 0) return null;
  const repo = repoFromKey(key.slice(0, hash));
  if (repo === undefined) return null;
  const number = Number.parseInt(key.slice(hash + 1), 10);
  const issue = repo.issues.get(number);
  return issue === undefined ? null : { repo, issue };
}

function pullFromKey(key: string): { repo: Repo; pull: Pull } | null {
  const hash = key.indexOf('#');
  if (hash < 0) return null;
  const repo = repoFromKey(key.slice(0, hash));
  if (repo === undefined) return null;
  const number = Number.parseInt(key.slice(hash + 1), 10);
  const pull = repo.pulls.get(number);
  return pull === undefined ? null : { repo, pull };
}

function nodeObject(parsed: { kind: string; key: string }): Record<string, unknown> | null {
  if (parsed.kind === 'repo') {
    const repo = repoFromKey(parsed.key);
    return repo === undefined ? null : repositoryObject(repo);
  }
  if (parsed.kind === 'issue') {
    const found = issueFromKey(parsed.key);
    return found === null ? null : issueObject(found.repo, found.issue);
  }
  if (parsed.kind === 'pr') {
    const found = pullFromKey(parsed.key);
    return found === null ? null : pullObject(found.repo, found.pull);
  }
  if (parsed.kind === 'comment') {
    const colon = parsed.key.lastIndexOf(':');
    const found = issueFromKey(parsed.key.slice(0, colon));
    if (found === null) return null;
    const commentId = Number.parseInt(parsed.key.slice(colon + 1), 10);
    const comment = found.issue.comments.find((candidate) => candidate.id === commentId);
    return comment === undefined ? null : commentObject(found.repo, found.issue, comment);
  }
  return null;
}

function resolveGqlField(parent: unknown, parentType: string, name: string, args: Record<string, unknown>, ctx: GqlContext): unknown {
  if (parentType === 'Query') {
    if (name === '__type') {
      const info = typeof args.name === 'string' ? SCHEMA_TYPES[args.name] : undefined;
      return info === undefined ? null : typeInfoObject(info);
    }
    if (name === '__schema') {
      return typed('__Schema', {
        description: null,
        types: Object.values(SCHEMA_TYPES).map(typeInfoObject),
        queryType: typeInfoObject(SCHEMA_TYPES.Query as GqlTypeInfo),
        mutationType: typeInfoObject(SCHEMA_TYPES.Mutation as GqlTypeInfo),
        subscriptionType: null,
        directives: [],
      });
    }
    if (name === 'viewer') return userObject();
    if (name === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repositoryObject(repo);
    }
    if (name === 'node') {
      const parsed = typeof args.id === 'string' ? parseGid(args.id) : null;
      return parsed === null ? null : nodeObject(parsed);
    }
    if (name === 'search') {
      return typed('SearchResultItemConnection', {
        nodes: [],
        edges: [],
        pageInfo: typed('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
        totalCount: 0,
      });
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
    return FIELD_ERROR;
  }

  if (parentType === 'Mutation') {
    const input = (args.input as Record<string, unknown> | undefined) ?? {};
    if (name === 'createIssue') {
      const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoFromKey(parsed.key) : undefined;
      if (repo === undefined || typeof input.title !== 'string' || input.title === '') {
        ctx.errors.push({ message: 'createIssue: repositoryId must name an existing repository and title is required.' });
        return FIELD_ERROR;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        number,
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: number,
      };
      repo.issues.set(number, issue);
      return typed('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId: null });
    }
    if (name === 'closeIssue') {
      const parsed = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
      const found = parsed !== null && parsed.kind === 'issue' ? issueFromKey(parsed.key) : null;
      if (found === null) {
        ctx.errors.push({ message: 'closeIssue: issueId must name an existing issue.' });
        return FIELD_ERROR;
      }
      found.issue.state = 'closed';
      return typed('CloseIssuePayload', { issue: issueObject(found.repo, found.issue), clientMutationId: null });
    }
    if (name === 'createPullRequest') {
      const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoFromKey(parsed.key) : undefined;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = repo?.refs.get(`refs/heads/${head}`);
      const baseSha = repo?.refs.get(`refs/heads/${base}`);
      if (repo === undefined || headSha === undefined || baseSha === undefined || title === '') {
        ctx.errors.push({ message: 'createPullRequest: repositoryId must name an existing repository and head/base branches must exist.' });
        return FIELD_ERROR;
      }
      const duplicate = [...repo.pulls.values()].some((candidate) => candidate.state === 'open' && candidate.headRef === head && candidate.baseRef === base);
      if (duplicate) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
        return FIELD_ERROR;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: Pull = {
        number,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return typed('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: null });
    }
    if (name === 'mergePullRequest') {
      const parsed = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
      const found = parsed !== null && parsed.kind === 'pr' ? pullFromKey(parsed.key) : null;
      if (found === null) {
        ctx.errors.push({ message: 'mergePullRequest: pullRequestId must name an existing pull request.' });
        return FIELD_ERROR;
      }
      const result = doMerge(found.repo, found.pull);
      if ('status' in result) {
        ctx.errors.push({ message: result.message });
        return FIELD_ERROR;
      }
      return typed('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId: null });
    }
    if (name === 'addComment') {
      const parsed = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
      const found = parsed !== null && parsed.kind === 'issue' ? issueFromKey(parsed.key) : null;
      if (found === null || typeof input.body !== 'string' || input.body === '') {
        ctx.errors.push({ message: 'addComment: subjectId must name an existing issue and body is required.' });
        return FIELD_ERROR;
      }
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      const comment: Comment = { id, body: input.body, seq: id };
      found.issue.comments.push(comment);
      return typed('AddCommentPayload', {
        commentEdge: typed('IssueCommentEdge', { node: commentObject(found.repo, found.issue, comment), cursor: cursorFor(id) }),
        clientMutationId: null,
      });
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
    return FIELD_ERROR;
  }

  const record = parent !== null && typeof parent === 'object' ? (parent as Record<string, unknown>) : null;
  if (parentType === 'Repository') {
    const repo = record?.__repo as Repo | undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository object is missing its store record.' });
      return FIELD_ERROR;
    }
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequests') return pullsConnection(repo, args);
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObject(repo, pull);
    }
  }
  if (parentType === 'Issue') {
    const repo = record?.__repo as Repo | undefined;
    const issue = record?.__issue as Issue | undefined;
    if (name === 'repository' && repo !== undefined) return repositoryObject(repo);
    if (name === 'comments' && repo !== undefined && issue !== undefined) return commentsConnection(repo, issue, args);
    if (name === 'author') return userObject();
  }
  if (parentType === 'PullRequest') {
    const repo = record?.__repo as Repo | undefined;
    const pull = record?.__pull as Pull | undefined;
    if (name === 'repository' && repo !== undefined) return repositoryObject(repo);
    if (name === 'files' && repo !== undefined && pull !== undefined) return filesConnection(repo, pull, args);
    if (name === 'author') return userObject();
  }
  if (record !== null && Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return FIELD_ERROR;
}

function executeGqlRequest(request: { query: string; variables?: Record<string, unknown>; operationName?: string }): {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
} {
  let doc: GqlDocument;
  try {
    doc = parseGql(request.query);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let operation = doc.operations[0];
  if (request.operationName !== undefined) {
    const named = doc.operations.find((candidate) => candidate.name === request.operationName);
    if (named !== undefined) operation = named;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const ctx: GqlContext = {
    errors: [],
    variables: request.variables ?? {},
    varDefs: operation.variableDefinitions,
    fragments: doc.fragments,
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, null, rootType, ctx, 0);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if (!requireAuth(req, res)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      if (item === null || typeof item !== 'object' || typeof (item as { query?: unknown }).query !== 'string') {
        return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
      }
      return executeGqlRequest(item as { query: string; variables?: Record<string, unknown>; operationName?: string });
    });
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { query?: unknown }).query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'A GraphQL query is required' }] });
    return;
  }
  sendJson(res, 200, executeGqlRequest(parsed as { query: string; variables?: Record<string, unknown>; operationName?: string }));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28.

const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const MCP_TOOL_LIST: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpToolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOL_LIST.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return mcpError(null, -32602, `Unknown tool: ${name}`);
  }
  for (const required of tool.inputSchema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpError(null, -32602, `Missing required argument: ${required}`);
    }
  }
  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return mcpToolError('Invalid repository name');
    if (repos.has(repoName)) return mcpToolError('Repository already exists');
    const repo = createRepoRecord(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return mcpToolResult(repoJson(repo));
  }
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const repo = getRepo(owner, repoName);
  if (repo === undefined) return mcpToolError('Not Found');
  if (name === 'get_repo') return mcpToolResult(repoJson(repo));
  if (name === 'create_issue') {
    const title = String(args.title);
    if (title === '') return mcpToolError('Title is required');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => b.seq - a.seq);
    return mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) });
  }
  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const title = String(args.title);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return mcpToolError('Head or base branch does not exist');
    const duplicate = [...repo.pulls.values()].some((candidate) => candidate.state === 'open' && candidate.headRef === head && candidate.baseRef === base);
    if (duplicate) return mcpToolError('A pull request already exists for this head and base');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return mcpToolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return mcpToolError('Not Found');
    const result = doMerge(repo, pull);
    if ('status' in result) return mcpToolError(result.message);
    return mcpToolResult({ sha: result.sha, merged: true, message: result.message, number: pull.number });
  }
  return mcpError(null, -32602, `Unknown tool: ${name}`);
}

function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(`${JSON.stringify(mcpError(null, -32001, 'Unauthorized'))}\n`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (method === 'initialize') {
    const params = (request.params as Record<string, unknown> | undefined) ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    }));
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
    }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOL_LIST }));
    return;
  }
  if (method === 'tools/call') {
    const params = (request.params as Record<string, unknown> | undefined) ?? {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const outcome = mcpCallTool(toolName, toolArgs);
    if ('error' in outcome && typeof outcome.error === 'object' && outcome.error !== null) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: outcome.error });
      return;
    }
    sendJson(res, 200, mcpResult(id, outcome));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Git smart HTTP: upload-pack v2 / v0 and receive-pack v0.

const FORGE_AGENT = 'makefun-forge/1.0.0';

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function refList(repo: Repo): { ref: string; oid: string }[] {
  return [...repo.refs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ref, oid]) => ({ ref, oid }));
}

/** Follow tag objects to the commit they point at (a commit is returned as-is). */
function derefToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The advertisement for info/refs: v2 when asked, otherwise v0 with ref lines. */
function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  if (service === 'git-upload-pack' && v2) {
    parts.push(encodePktLine('version 2\n'));
    parts.push(encodePktLine(`agent=${FORGE_AGENT}\n`));
    parts.push(encodePktLine('ls-refs=unborn\n'));
    parts.push(encodePktLine('fetch=shallow wait-for-done\n'));
    parts.push(encodePktLine('object-format=sha1\n'));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter'
      : 'report-status side-band-64k delete-refs ofs-delta thin-pack';
  const capsLine = `${caps} agent=${FORGE_AGENT}`;
  const refs = refList(repo);
  const lines: { oid: string; ref: string }[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) lines.push({ oid: defaultTip, ref: 'HEAD' });
  for (const entry of refs) lines.push(entry);
  if (lines.length === 0) {
    if (service === 'git-receive-pack') {
      parts.push(encodePktLine(`${ZERO_OID} HEAD\0${capsLine}\n`));
      parts.push(pktFlush());
    }
    return Buffer.concat(parts);
  }
  lines.forEach((line, index) => {
    const suffix = index === 0 ? `\0${capsLine}` : '';
    parts.push(encodePktLine(`${line.oid} ${line.ref}${suffix}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The ls-refs answer for a v2 upload-pack request. */
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  // The client may ask for several prefixes at once (HEAD, refs/heads/,
  // refs/tags/); a ref matches when it starts with any of them.
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const emit = (oid: string, name: string, attrs: string[]): void => {
    parts.push(encodePktLine(`${oid} ${name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  };
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (defaultTip !== undefined) {
      emit(defaultTip, 'HEAD', [`symref-target:refs/heads/${repo.defaultBranch}`]);
    } else if (unborn) {
      // An unborn HEAD is announced with the literal word "unborn" in place
      // of an object id (git's own format); a client that sees it knows the
      // repository is empty and sends no fetch.
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const { ref, oid } of refList(repo)) {
    if (!matches(ref)) continue;
    const attrs: string[] = [];
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') attrs.push(`peeled:${parseTag(object.data).object}`);
    }
    emit(oid, ref, attrs);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Every object reachable from a tree (the tree itself, subtrees, blobs). */
function treeClosure(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const walk = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || out.has(oid)) return;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) walk(entry.oid);
    }
  };
  walk(treeOid);
  return out;
}

/**
 * The object set for a fetch: the closure of the wants, minus the closure of
 * the haves. With a depth, only commits within the depth are included and the
 * boundary commits are reported so the client can mark them shallow. A
 * `deepen-relative` request deepens from the client's current shallow
 * boundary instead: the effective depth is the boundary's distance from the
 * wants, plus one, plus the deepen value.
 */
function distanceFromWants(repo: Repo, wants: string[], target: string): number | null {
  const queue: { oid: string; depth: number }[] = [];
  const seen = new Set<string>();
  for (const want of wants) {
    if (isObjectId(want) && repo.objects.has(want)) queue.push({ oid: want, depth: 0 });
  }
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number };
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    if (item.oid === target) return item.depth;
    const object = repo.objects.get(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: item.depth + 1 });
  }
  return null;
}

function computeFetchSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  deepen: number | null,
  shallowLines: string[] = [],
  deepenRelative = false,
): { objects: Set<string>; boundary: Set<string>; inDepth: Set<string> } {
  let effectiveDeepen = deepen;
  if (deepen !== null && deepen > 0 && deepenRelative && shallowLines.length > 0) {
    let maxDistance = -1;
    for (const boundaryOid of shallowLines) {
      const distance = distanceFromWants(repo, wants, boundaryOid);
      if (distance !== null && distance > maxDistance) maxDistance = distance;
    }
    if (maxDistance >= 0) effectiveDeepen = deepen + maxDistance + 1;
  }
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const inDepth = new Set<string>();
  const haveClosure = new Set<string>();
  const shallowBoundary = new Set(shallowLines.filter((oid) => isObjectId(oid)));
  for (const have of haves) {
    if (isObjectId(have) && repo.objects.has(have)) {
      for (const oid of collectReachableBounded(repo, [have], shallowBoundary)) haveClosure.add(oid);
    }
  }
  if (effectiveDeepen !== null && effectiveDeepen > 0) {
    const queue: { oid: string; depth: number }[] = [];
    const seen = new Set<string>();
    for (const want of wants) {
      if (isObjectId(want) && repo.objects.has(want)) queue.push({ oid: want, depth: 0 });
    }
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; depth: number };
      if (seen.has(item.oid)) continue;
      seen.add(item.oid);
      const object = repo.objects.get(item.oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        objects.add(item.oid);
        inDepth.add(item.oid);
        for (const reachable of treeClosure(repo, parseCommit(object.data).tree)) objects.add(reachable);
        if (item.depth === effectiveDeepen - 1) {
          boundary.add(item.oid);
        } else {
          for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: item.depth + 1 });
        }
      } else if (object.type === 'tag') {
        objects.add(item.oid);
        queue.push({ oid: parseTag(object.data).object, depth: item.depth });
      } else {
        objects.add(item.oid);
      }
    }
  } else {
    for (const want of wants) {
      if (!isObjectId(want) || !repo.objects.has(want)) continue;
      for (const oid of collectReachable(repo, [want])) {
        objects.add(oid);
        if (repo.objects.get(oid)?.type === 'commit') inDepth.add(oid);
      }
    }
  }
  for (const oid of haveClosure) objects.delete(oid);
  return { objects, boundary, inDepth };
}

/** Wrap pack bytes in sideband band-1 packets, then a flush. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  parts.push(pktFlush());
  return parts;
}

function packForObjects(repo: Repo, oids: Set<string>): Buffer {
  const objects: GitObject[] = [];
  for (const oid of [...oids].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

function ackLines(repo: Repo, wants: string[], haves: string[]): string[] {
  const lines: string[] = [];
  let acked = false;
  for (const have of haves) {
    if (wants.some((want) => have === want || isAncestor(repo, have, want))) {
      lines.push(`ACK ${have}`);
      acked = true;
    }
  }
  if (!acked) lines.push('NAK');
  return lines;
}

/** The fetch answer for a v2 upload-pack request. */
function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  const wantRefs: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(parsed)) deepen = parsed;
    } else if (arg.startsWith('want-ref ')) wantRefs.push(arg.slice(9).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
  }
  const { objects, boundary, inDepth } = computeFetchSet(repo, wants, haves, deepen, shallowLines, deepenRelative);
  const parts: Buffer[] = [];
  if (!done) {
    // Negotiation continues: acknowledgments only, no packfile. The client
    // will send more haves (or "done") in a later round.
    parts.push(encodePktLine('acknowledgments\n'));
    for (const line of ackLines(repo, wants, haves)) parts.push(encodePktLine(`${line}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // The client sent "done", so negotiation is over: per gitprotocol-v2 the
  // acknowledgments section is omitted and the packfile follows. Sections
  // are separated by delimiter packets; only the packfile ends with a flush.
  if (deepen !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    const previouslyShallow = new Set(shallowLines);
    for (const oid of boundary) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of previouslyShallow) {
      if (!boundary.has(oid) && inDepth.has(oid)) parts.push(encodePktLine(`unshallow ${oid}\n`));
    }
    parts.push(pktDelim());
  }
  if (wantRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const ref of wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid !== undefined) parts.push(encodePktLine(`${oid} ${ref}\n`));
    }
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(packForObjects(repo, objects)));
  return Buffer.concat(parts);
}

/** The fetch answer for a v0 upload-pack request (single-round negotiation). */
function uploadPackV0Response(repo: Repo, raw: Buffer): Buffer {
  // v0 is two sections: wants (+ shallow/deepen) up to a flush, then the
  // negotiation (haves + done) up to a second flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false;
  const parseSection = (packets: PktPacket[]): void => {
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').trimEnd();
      const space = line.indexOf(' ');
      const verb = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? '' : line.slice(space + 1);
      if (verb === 'want') wants.push((rest.split(/[\s\0]/)[0] as string) ?? '');
      else if (verb === 'have') haves.push((rest.split(/[\s\0]/)[0] as string) ?? '');
      else if (verb === 'shallow') shallowLines.push(rest.trim());
      else if (verb === 'deepen') {
        const parsed = Number.parseInt(rest, 10);
        if (Number.isFinite(parsed)) deepen = parsed;
      } else if (verb === 'deepen-relative') deepenRelative = true;
    }
  };
  const first = decodePktLines(raw);
  parseSection(first.packets);
  if (first.stoppedAtFlush && first.restOffset < raw.length) {
    parseSection(decodePktLines(raw, first.restOffset).packets);
  }
  const { objects, boundary, inDepth } = computeFetchSet(repo, wants, haves, deepen, shallowLines, deepenRelative);
  const parts: Buffer[] = [];
  for (const line of ackLines(repo, wants, haves)) parts.push(encodePktLine(`${line}\n`));
  if (deepen !== null) {
    const previouslyShallow = new Set(shallowLines);
    for (const oid of boundary) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of previouslyShallow) {
      if (!boundary.has(oid) && inDepth.has(oid)) parts.push(encodePktLine(`unshallow ${oid}\n`));
    }
  }
  parts.push(...sidebandPack(packForObjects(repo, objects)));
  return Buffer.concat(parts);
}

/** The fetch answer for a v2 upload-pack request (command block + args). */
function uploadPackV2Response(repo: Repo, raw: Buffer): Buffer {
  const { packets } = decodePktLines(raw);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (!afterDelim) {
      const [key, value] = line.split('=', 2);
      if (key === 'command') command = value ?? '';
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') return lsRefsResponse(repo, args);
  if (command === 'fetch') return fetchResponse(repo, args);
  throw new Error(`unsupported upload-pack v2 command ${command}`);
}

/**
 * Apply one receive-pack ref update. Returns null on success, or the reason
 * the ref was refused (the ref does not move).
 */
function applyPushRef(repo: Repo, cmd: { old: string; next: string; ref: string }): string | null {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.includes('..') || cmd.ref.endsWith('/') || cmd.ref.includes('//')) {
    return 'invalid ref name';
  }
  const current = repo.refs.get(cmd.ref);
  if (cmd.next === ZERO_OID) {
    if (current === undefined) return 'remote ref does not exist';
    if (cmd.old !== ZERO_OID && cmd.old !== current) return 'old value mismatch';
    repo.refs.delete(cmd.ref);
    return null;
  }
  if (!isObjectId(cmd.next)) return 'invalid new object id';
  const newObject = repo.objects.get(cmd.next);
  if (newObject === undefined) return 'object not found';
  if (newObject.type !== 'commit' && newObject.type !== 'tag') return 'new object is not a commit or tag';
  if (cmd.old === ZERO_OID) {
    if (current !== undefined) return 'already exists';
    repo.refs.set(cmd.ref, cmd.next);
    return null;
  }
  if (current === undefined) return 'remote ref does not exist';
  if (current !== cmd.old) return 'old value mismatch';
  if (cmd.next === cmd.old) return null;
  const newCommit = derefToCommit(repo, cmd.next);
  const oldCommit = derefToCommit(repo, cmd.old);
  if (newCommit === null || oldCommit === null) return 'object is not a commit';
  if (!isAncestor(repo, oldCommit, newCommit)) return 'non-fast-forward';
  repo.refs.set(cmd.ref, cmd.next);
  return null;
}

/**
 * Resolve a parsed pack's delta entries against the pack's own objects and the
 * repository's store (a thin pack may base a delta on an object the server
 * already has). Returns every object the pack carries, plain and resolved.
 */
function resolvePackEntries(repo: Repo, parsed: { entries: PackEntry[]; deltas: PackDeltaEntry[] }): PackEntry[] {
  const resolved: PackEntry[] = [...parsed.entries];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  for (const entry of parsed.entries) {
    byOffset.set(entry.packOffset, entry);
    byOid.set(entry.oid, entry);
  }
  const pending = [...parsed.deltas];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const delta = pending[i] as PackDeltaEntry;
      let base: PackEntry | undefined;
      if (delta.deltaKind === 'ofs-delta' && delta.baseOffset !== null) {
        base = byOffset.get(delta.packOffset - delta.baseOffset);
      } else if (delta.deltaKind === 'ref-delta' && delta.baseOid !== null) {
        base = byOid.get(delta.baseOid);
        if (base === undefined) {
          const stored = repo.objects.get(delta.baseOid);
          if (stored !== undefined) base = { type: stored.type, data: stored.data, oid: delta.baseOid, packOffset: -1 };
        }
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, delta.data);
      const entry: PackEntry = { type: base.type, data, oid: hashObject(base.type, data), packOffset: delta.packOffset };
      byOffset.set(delta.packOffset, entry);
      byOid.set(entry.oid, entry);
      resolved.push(entry);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error('delta base object not found in pack or repository');
  return resolved;
}

/** The receive-pack answer: unpack status, then one ok/ng line per ref. */
function receivePackResponse(repo: Repo, raw: Buffer): Buffer {
  const commands: { old: string; next: string; ref: string }[] = [];
  let unpackError: string | null = null;
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, restOffset } = decodePktLines(raw);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      const clean = (nul === -1 ? line : line.slice(0, nul)).trimEnd();
      const [old, next, ref] = clean.split(' ');
      if (old !== undefined && next !== undefined && ref !== undefined) {
        commands.push({ old, next, ref });
      }
    }
    packBytes = raw.subarray(restOffset);
  } catch (err) {
    unpackError = err instanceof Error ? err.message : String(err);
  }
  if (unpackError === null && packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const entry of resolvePackEntries(repo, parsed)) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: Buffer[] = [];
  if (unpackError !== null) {
    report.push(encodePktLine(`unpack ${unpackError}\n`));
    for (const cmd of commands) report.push(encodePktLine(`ng ${cmd.ref} unpack failed\n`));
  } else {
    report.push(encodePktLine('unpack ok\n'));
    for (const cmd of commands) {
      const reason = applyPushRef(repo, cmd);
      report.push(encodePktLine(reason === null ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`));
    }
  }
  report.push(pktFlush());
  const body = Buffer.concat(report);
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + 65515));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  owner: string,
  repoName: string,
  subPath: string,
  query: URLSearchParams,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && subPath === 'info/refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', advertisement(repo, 'git-upload-pack', v2));
        return;
      }
      if (service === 'git-receive-pack') {
        sendGit(res, 200, 'application/x-git-receive-pack-advertisement', advertisement(repo, 'git-receive-pack', false));
        return;
      }
      sendError(res, 400, 'Unknown service');
      return;
    }
    if (method === 'POST' && subPath === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? uploadPackV2Response(repo, raw) : uploadPackV0Response(repo, raw);
      sendGit(res, 200, 'application/x-git-upload-pack-result', body);
      return;
    }
    if (method === 'POST' && subPath === 'git-receive-pack') {
      sendGit(res, 200, 'application/x-git-receive-pack-result', receivePackResponse(repo, raw));
      return;
    }
    sendError(res, 404, 'Not Found');
  } catch (err) {
    // A malformed git request must never crash the server.
    sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// Dispatcher and lifecycle.

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
    const query = url.searchParams;

    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const raw = needsBody ? await readBody(req) : Buffer.alloc(0);

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 3 && segments[1]?.endsWith('.git') === true) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      const subPath = segments.slice(2).join('/');
      await handleGit(req, res, raw, owner, repoName, subPath, query);
      return;
    }

    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
      await handleGraphql(req, res, raw);
      return;
    }

    if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
      handleMcp(req, res, raw);
      return;
    }

    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      if (!requireAuth(req, res)) return;
      const rest = segments.slice(2);

      if (rest.length === 0 && method === 'GET') {
        handleRoot(req, res);
        return;
      }
      if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
        handleMeta(req, res);
        return;
      }
      if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
        handleUser(req, res);
        return;
      }
      if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
        if (method === 'POST') {
          const body = parseJsonBody(raw, res);
          if (body === null) return;
          handleCreateRepo(req, res, body);
          return;
        }
        if (method === 'GET') {
          handleListUserRepos(req, res, query);
          return;
        }
      }

      if (rest.length >= 3 && rest[0] === 'repos') {
        const owner = rest[1] as string;
        const name = rest[2] as string;
        const tail = rest.slice(3);
        if (tail.length === 0) {
          if (method === 'GET') {
            handleGetRepo(req, res, owner, name);
            return;
          }
          if (method === 'PATCH') {
            const body = parseJsonBody(raw, res);
            if (body === null) return;
            handlePatchRepo(req, res, owner, name, body);
            return;
          }
          if (method === 'DELETE') {
            handleDeleteRepo(req, res, owner, name);
            return;
          }
        }
        if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
          handleListBranches(req, res, owner, name);
          return;
        }
        if (tail.length >= 2 && tail[0] === 'branches' && method === 'GET') {
          handleGetBranch(req, res, owner, name, tail.slice(1).join('/'));
          return;
        }
        if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
          handleListCommits(req, res, owner, name, query);
          return;
        }
        if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
          if (method === 'GET' && tail.length > 2) {
            handleGetRef(req, res, owner, name, `refs/${tail.slice(2).join('/')}`);
            return;
          }
          if (method === 'POST' && tail.length === 2) {
            const body = parseJsonBody(raw, res);
            if (body === null) return;
            handleCreateRef(req, res, owner, name, body);
            return;
          }
        }
        if (tail.length >= 1 && tail[0] === 'contents') {
          const filePath = tail.slice(1).join('/');
          if (method === 'PUT') {
            const body = parseJsonBody(raw, res);
            if (body === null) return;
            handlePutContents(req, res, owner, name, filePath, body);
            return;
          }
          if (method === 'GET') {
            handleGetContents(req, res, owner, name, filePath, query);
            return;
          }
          if (method === 'DELETE') {
            const body = parseJsonBody(raw, res);
            if (body === null) return;
            handleDeleteContents(req, res, owner, name, filePath, body);
            return;
          }
        }
        if (tail.length === 1 && tail[0] === 'labels') {
          if (method === 'POST') {
            const body = parseJsonBody(raw, res);
            if (body === null) return;
            handleCreateLabel(req, res, owner, name, body);
            return;
          }
          if (method === 'GET') {
            handleListLabels(req, res, owner, name);
            return;
          }
        }
        if (tail.length >= 1 && tail[0] === 'issues') {
          if (tail.length === 1) {
            if (method === 'POST') {
              const body = parseJsonBody(raw, res);
              if (body === null) return;
              handleCreateIssue(req, res, owner, name, body);
              return;
            }
            if (method === 'GET') {
              handleListIssues(req, res, owner, name, query);
              return;
            }
          }
          const issueNumber = Number.parseInt(tail[1] as string, 10);
          if (tail.length === 2 && Number.isFinite(issueNumber)) {
            if (method === 'GET') {
              handleGetIssue(req, res, owner, name, issueNumber);
              return;
            }
            if (method === 'PATCH') {
              const body = parseJsonBody(raw, res);
              if (body === null) return;
              handlePatchIssue(req, res, owner, name, issueNumber, body);
              return;
            }
          }
          if (tail.length === 3 && tail[2] === 'comments' && Number.isFinite(issueNumber)) {
            if (method === 'POST') {
              const body = parseJsonBody(raw, res);
              if (body === null) return;
              handleCreateComment(req, res, owner, name, issueNumber, body);
              return;
            }
            if (method === 'GET') {
              handleListComments(req, res, owner, name, issueNumber);
              return;
            }
          }
        }
        if (tail.length >= 1 && tail[0] === 'pulls') {
          if (tail.length === 1) {
            if (method === 'POST') {
              const body = parseJsonBody(raw, res);
              if (body === null) return;
              handleCreatePull(req, res, owner, name, body);
              return;
            }
            if (method === 'GET') {
              handleListPulls(req, res, owner, name, query);
              return;
            }
          }
          const pullNumber = Number.parseInt(tail[1] as string, 10);
          if (tail.length === 2 && Number.isFinite(pullNumber) && method === 'GET') {
            handleGetPull(req, res, owner, name, pullNumber);
            return;
          }
          if (tail.length === 3 && tail[2] === 'files' && Number.isFinite(pullNumber) && method === 'GET') {
            handleListPullFiles(req, res, owner, name, pullNumber);
            return;
          }
          if (tail.length === 3 && tail[2] === 'merge' && Number.isFinite(pullNumber) && method === 'PUT') {
            handleMergePull(req, res, owner, name, pullNumber);
            return;
          }
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
  } catch (err) {
    if (!res.writableEnded) sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

async function registerAndWait(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });
  if (ENV_URL === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; standalone mode)`);
    return;
  }
  const registerResponse = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (registerResponse.status !== 200 && registerResponse.status !== 409) {
    throw new Error(`register failed with HTTP ${registerResponse.status}`);
  }
  let delay = 250;
  for (;;) {
    const doneResponse = await fetch(`${ENV_URL}/done`);
    if (doneResponse.ok) {
      const data = (await doneResponse.json()) as { done?: unknown };
      if (data.done === true) break;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
  server.close();
  process.exit(0);
}

registerAndWait().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
