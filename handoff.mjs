import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const MAX_PROGRESS = 50_000;
const MAX_TITLE = 512;
const MAX_CWD = 4_096;
const locks = new Map();

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new TypeError(`${name} must match ${ID_RE}`);
}
function assertText(value, name, max, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new TypeError(`${name} must be a string of at most ${max} characters`);
  }
}
function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

async function secureDirectory(directory, create = false) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const relative = path.relative(parsed.root, absolute);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe symlink or directory: ${current}`);
      const real = path.resolve(await fs.realpath(current));
      if ((process.platform === 'win32' ? real.toLowerCase() !== current.toLowerCase() : real !== current)) throw new Error(`unsafe symlink or junction: ${current}`);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`unsafe symlink or directory: ${current}`);
    }
  }
  return absolute;
}

async function secureFile(file, allowMissing = true) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe file: ${file}`);
    return stat;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file, content) {
  await secureFile(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function withLock(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}

export class HandoffStore {
  constructor({ root }) {
    if (typeof root !== 'string' || !root || root.includes('\0')) throw new TypeError('root is required');
    this.root = path.resolve(root);
  }

  async #paths(codexId, dshId) {
    const root = await secureDirectory(this.root, true);
    const codex = await secureDirectory(path.join(root, codexId), true);
    const pair = await secureDirectory(path.join(codex, dshId), true);
    const history = await secureDirectory(path.join(pair, 'history'), true);
    return { pair, history, latest: path.join(pair, 'latest.md'), manifest: path.join(pair, 'manifest.json') };
  }

  #metadata(codexSession, dshSession, progress) {
    return {
      codexSession: { id: codexSession.id, title: codexSession.title, cwd: codexSession.cwd },
      dshSession: { id: dshSession.id, title: dshSession.title, ...(dshSession.cwd === undefined ? {} : { cwd: dshSession.cwd }) },
      progress,
    };
  }

  #body(metadata) {
    const { codexSession, dshSession, progress } = metadata;
    return [
      '# DSH handoff', '',
      `- DSH session: ${dshSession.title} (${dshSession.id})`,
      `- Codex session: ${codexSession.title} (${codexSession.id})`,
      `- Codex working directory: ${codexSession.cwd}`,
      ...(dshSession.cwd === undefined ? [] : [`- DSH working directory: ${dshSession.cwd}`]),
      '', '## Progress', '', progress, '',
    ].join('\n');
  }

  #hash(metadata, body) { return digest(`${json(metadata)}${body}`); }

  async save({ codexSession, dshSession, progress }) {
    if (!codexSession || !dshSession) throw new TypeError('codexSession and dshSession are required');
    assertId(codexSession.id, 'codexSession.id'); assertId(dshSession.id, 'dshSession.id');
    assertText(codexSession.title, 'codexSession.title', MAX_TITLE);
    assertText(dshSession.title, 'dshSession.title', MAX_TITLE);
    assertText(codexSession.cwd, 'codexSession.cwd', MAX_CWD);
    assertText(dshSession.cwd, 'dshSession.cwd', MAX_CWD, true);
    assertText(progress, 'progress', MAX_PROGRESS);
    if (progress.length === 0) throw new TypeError('progress must not be empty');

    const key = `${this.root}\0${codexSession.id}\0${dshSession.id}`;
    return withLock(key, async () => {
      const paths = await this.#paths(codexSession.id, dshSession.id);
      const metadata = this.#metadata(codexSession, dshSession, progress);
      const body = this.#body(metadata);
      const hash = this.#hash(metadata, body);
      let old;
      try {
        await secureFile(paths.manifest);
        old = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }

      if (old) await this.#verify(paths, old, codexSession.id, dshSession.id);
      if (old?.hash === hash) {
        return this.#result(paths, old, codexSession.cwd, true);
      }
      const revision = Number.isInteger(old?.revision) && old.revision >= 0 ? old.revision + 1 : 1;
      const historyPath = path.join(paths.history, `${hash}.md`);
      const existing = await secureFile(historyPath);
      if (existing) {
        if (await fs.readFile(historyPath, 'utf8') !== body) throw new Error(`immutable history mismatch: ${historyPath}`);
      } else await atomicWrite(historyPath, body);
      const manifest = { ...metadata, revision, hash, updatedAt: new Date().toISOString() };
      await atomicWrite(paths.latest, body);
      await atomicWrite(paths.manifest, json(manifest));
      return this.#result(paths, manifest, codexSession.cwd, false, historyPath);
    });
  }

  async #verify(paths, manifest, codexId, dshId) {
    if (manifest.codexSession?.id !== codexId || manifest.dshSession?.id !== dshId || typeof manifest.hash !== 'string') throw new Error('invalid handoff manifest');
    await secureFile(paths.latest, false);
    const body = await fs.readFile(paths.latest, 'utf8');
    if (this.#hash({ codexSession: manifest.codexSession, dshSession: manifest.dshSession, progress: manifest.progress }, body) !== manifest.hash) throw new Error('handoff integrity check failed');
    const history = path.join(paths.history, `${manifest.hash}.md`);
    await secureFile(history, false);
    if (await fs.readFile(history, 'utf8') !== body) throw new Error('handoff history mismatch');
  }

  #result(paths, manifest, cwd, unchanged, historyPath = path.join(paths.history, `${manifest.hash}.md`)) {
    return { path: paths.latest, manifestPath: paths.manifest, revision: manifest.revision, unchanged, codexSessionId: manifest.codexSession.id, dshSessionId: manifest.dshSession.id, codexPrompt: this.#prompt(historyPath, paths.latest, cwd) };
  }
  #prompt(history, latest, cwd) { return `DSH handoff source: read the immutable history file ${history}. The current pair latest file is ${latest}. Verify the working directory is ${cwd}, then continue the work from the progress recorded there.`; }

  async latest(codexId, dshId) {
    assertId(codexId, 'codexId'); assertId(dshId, 'dshId');
    return withLock(`${this.root}\0${codexId}\0${dshId}`, async () => {
      const paths = await this.#paths(codexId, dshId);
      if (!await secureFile(paths.manifest)) return null;
      const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
      if (manifest.codexSession?.id !== codexId || manifest.dshSession?.id !== dshId) return null;
      await this.#verify(paths, manifest, codexId, dshId);
      return { path: paths.latest, manifestPath: paths.manifest, manifest, content: await fs.readFile(paths.latest, 'utf8') };
    });
  }
}

export default HandoffStore;
