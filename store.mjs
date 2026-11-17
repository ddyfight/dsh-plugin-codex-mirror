import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CHUNK = 64 * 1024;
const absent = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const newer = (a, b) => Date.parse(b || '') > Date.parse(a || '') ? b : a;

async function discover(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (absent(error)) return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const name = path.join(dir, entry.name);
    // Do not follow symlinks outside the two session trees.
    if (entry.isDirectory()) result.push(...await discover(name));
    else if (entry.isFile() && /^rollout.*\.jsonl$/i.test(entry.name)) result.push(name);
  }
  return result;
}

function fresh(file, archived = false) {
  return { file, archived, offset: 0, pending: Buffer.alloc(0), anchor: Buffer.alloc(0),
    dev: null, ino: null, mtime: null, size: null, id: null, cwd: '', timestamp: '',
    messages: [], seen: new Set(), unmatched: new Map(), turn: '', status: 'idle' };
}

/** Read-only mirror of Codex rollout JSONL. Never executes commands or writes files. */
export class MirrorStore extends EventEmitter {
  constructor({ root = path.join(homedir(), '.codex'), pollMs = 1000 } = {}) {
    super();
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('pollMs must be positive');
    this.root = path.resolve(root);
    this.pollMs = pollMs;
    this.files = new Map();
    this.sessions = new Map();
    this.index = fresh(path.join(this.root, 'session_index.jsonl'));
    this.titles = new Map();
    this.timer = null;
    this.running = false;
    this.work = null;
  }

  async start() {
    if (this.running) { await this.work; return this; }
    this.running = true;
    try { await this._poll(); }
    catch (error) { this.running = false; throw error; }
    if (this.running) {
      this.timer = setInterval(() => {
        this._poll().catch(error => {
          if (this.listenerCount('error')) this.emit('error', error);
        });
      }, this.pollMs);
      this.timer.unref?.();
    }
    return this;
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    await this.work;
  }

  listSessions() {
    return [...this.sessions.values()].sort((a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id))
      .map(({ messages, ...session }) => ({ ...session }));
  }

  getSession(id) {
    const session = this.sessions.get(id);
    return session ? this._snapshot(session) : undefined;
  }

  _snapshot(session) {
    return { ...session, messages: session.messages.map(message => ({ ...message })) };
  }

  _poll() {
    if (this.work) return this.work;
    this.work = this._scan().finally(() => { this.work = null; });
    return this.work;
  }

  async _scan() {
    const rootStat = await stat(this.root);
    if (!rootStat.isDirectory()) throw new Error(`Codex root is not a directory: ${this.root}`);
    let dirty = false;
    dirty = await this._read(this.index, record => {
      const id = record.id ?? record.session_id;
      if (typeof id === 'string') this.titles.set(id, record);
    }, () => { this.titles.clear(); Object.assign(this.index, fresh(this.index.file)); }) || dirty;
    const active = await discover(path.join(this.root, 'sessions'));
    const archived = await discover(path.join(this.root, 'archived_sessions'));
    const found = new Set([...active, ...archived]);
    const archivedSet = new Set(archived);
    for (const file of found) {
      let state = this.files.get(file);
      if (!state) { state = fresh(file, archivedSet.has(file)); this.files.set(file, state); dirty = true; }
      dirty = await this._read(state, (record, offset) => this._record(state, record, offset), () => {
        Object.assign(state, fresh(file, archivedSet.has(file)));
      }) || dirty;
    }
    for (const file of this.files.keys()) {
      if (!found.has(file)) { this.files.delete(file); dirty = true; }
    }
    if (dirty) this._rebuild();
  }

  async _read(state, consume, reset) {
    let handle;
    try { handle = await open(state.file, 'r'); }
    catch (error) {
      if (!absent(error)) throw error;
      if (state.offset || state.size !== null) { reset(); return true; }
      return false;
    }
    try {
      const stat = await handle.stat();
      let changed = state.size !== stat.size || state.mtime !== stat.mtimeMs;
      let replaced = state.ino !== null && (state.ino !== stat.ino || state.dev !== stat.dev);
      if (stat.size < state.offset) replaced = true;
      // Verify consumed bytes to catch truncate-and-regrow between polls.
      if (!replaced && state.anchor.length) {
        const check = Buffer.alloc(state.anchor.length);
        const { bytesRead } = await handle.read(check, 0, check.length, state.offset - check.length);
        if (bytesRead !== check.length || !check.equals(state.anchor)) replaced = true;
      }
      if (!replaced && state.size === stat.size && state.mtime !== null && state.mtime !== stat.mtimeMs) replaced = true;
      if (replaced) { reset(); changed = true; }
      state.ino = stat.ino;
      state.dev = stat.dev;
      const target = stat.size;
      while (state.offset < target) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, target - state.offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset);
        if (!bytesRead) break;
        const data = Buffer.concat([state.pending, chunk.subarray(0, bytesRead)]);
        const base = state.offset - state.pending.length;
        state.offset += bytesRead;
        let from = 0;
        for (let end = data.indexOf(10, from); end !== -1; end = data.indexOf(10, from)) {
          const line = data.subarray(from, end).toString('utf8').replace(/^\uFEFF/, '');
          let record;
          try { record = JSON.parse(line); } catch { /* Skip malformed complete lines. */ }
          if (record && typeof record === 'object') consume(record, base + from);
          from = end + 1;
        }
        // Keep bytes: a poll can split a multibyte UTF-8 character.
        state.pending = Buffer.from(data.subarray(from));
      }
      state.anchor = Buffer.alloc(Math.min(256, state.offset));
      if (state.anchor.length) await handle.read(state.anchor, 0, state.anchor.length, state.offset - state.anchor.length);
      state.size = target;
      state.mtime = stat.mtimeMs;
      return changed || replaced;
    } finally { await handle.close(); }
  }

  _record(state, record, offset) {
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') return;
    if (typeof record.timestamp === 'string') state.timestamp = newer(state.timestamp, record.timestamp) || record.timestamp;
    if (record.type === 'session_meta') {
      state.id = payload.id ?? payload.session_id ?? state.id;
      state.cwd = typeof payload.cwd === 'string' ? payload.cwd : state.cwd;
      state.timestamp ||= payload.timestamp || '';
      return;
    }
    let role, text, source;
    if (record.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      role = payload.role;
      source = 'response';
      text = Array.isArray(payload.content) ? payload.content
        .filter(item => item && ['input_text', 'output_text', 'text'].includes(item.type) && typeof item.text === 'string')
        .map(item => item.text).join('\n') : '';
    } else if (record.type === 'event_msg') {
      if (payload.type === 'task_started') { state.status = 'running'; state.turn = payload.turn_id || String(offset); }
      if (['task_complete', 'task_completed', 'turn_complete', 'turn_completed'].includes(payload.type)) state.status = 'idle';
      if (['turn_aborted', 'task_interrupted'].includes(payload.type)) state.status = 'interrupted';
      if (!['user_message', 'agent_message'].includes(payload.type)) return;
      role = payload.type === 'user_message' ? 'user' : 'assistant';
      source = 'event';
      text = typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text :
        Array.isArray(payload.content) ? payload.content.filter(item => item && typeof item.text === 'string').map(item => item.text).join('\\n') : '';
    }
    if (!role || typeof text !== 'string' || !text.trim()) return;
    if (payload.id) {
      const key = `${source}:${payload.id}`;
      if (state.seen.has(key)) return;
      state.seen.add(key);
    }
    const key = JSON.stringify([state.turn, role, text]);
    const pending = state.unmatched.get(key) || { event: [], response: [] };
    const opposite = source === 'event' ? 'response' : 'event';
    if (pending[opposite].length) {
      pending[opposite].shift();
    } else {
      const message = { id: payload.id || `${state.id || path.basename(state.file)}:${offset}`,
        role, text, timestamp: record.timestamp || null };
      state.messages.push(message);
      pending[source].push(message);
    }
    state.unmatched.set(key, pending);
  }

  _rebuild() {
    const next = new Map();
    for (const state of this.files.values()) {
      const id = state.id || path.basename(state.file).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
      if (!id) continue;
      const title = this.titles.get(id);
      const session = { id, title: title?.thread_name || title?.title || state.messages.find(m => m.role === 'user')?.text.slice(0, 80) || id,
        cwd: state.cwd, updatedAt: newer(state.timestamp, title?.updated_at) || state.timestamp || '',
        messages: state.messages, status: state.archived ? 'archived' : state.status };
      // A session can briefly exist in both trees during archival.
      const previous = next.get(id);
      if (!previous || Date.parse(session.updatedAt) > Date.parse(previous.updatedAt) ||
          (session.updatedAt === previous.updatedAt && session.messages.length > previous.messages.length)) next.set(id, session);
    }
    const changed = new Set([...this.sessions.keys(), ...next.keys()]);
    const prior = this.sessions;
    this.sessions = new Map([...next].map(([id, session]) => [id, this._snapshot(session)]));
    for (const id of changed) {
      if (JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id))) this.emit('change', { id });
    }
  }
}

export default MirrorStore;
