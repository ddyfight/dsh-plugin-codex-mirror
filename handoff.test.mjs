import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HandoffStore } from './handoff.mjs';

async function fixture() { return mkdtemp(path.join(os.tmpdir(), 'codex-handoff-')); }
const sessions = { codexSession: { id: 'codex_1', title: 'Codex', cwd: 'D:\\work' }, dshSession: { id: 'dsh_1', title: 'DSH' } };

 test('stores under the session pair, deduplicates, and returns an immutable prompt', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  const first = await store.save({ ...sessions, progress: 'first progress' });
  assert.equal(first.revision, 1); assert.equal(first.unchanged, false);
  assert.match(first.codexPrompt, /history[\\/][a-f0-9]{64}\.md/);
  assert.equal(first.path, path.join(root, 'codex_1', 'dsh_1', 'latest.md'));
  const firstHistory = first.codexPrompt.match(/history[\\/][a-f0-9]{64}\.md/)[0];
  const second = await store.save({ ...sessions, progress: 'first progress' });
  assert.equal(second.unchanged, true); assert.equal(second.revision, 1);
  assert.equal((await readdir(path.join(root, 'codex_1', 'dsh_1', 'history'))).length, 1);
  assert.equal((await readFile(path.join(root, 'codex_1', 'dsh_1', firstHistory.replaceAll('\\', path.sep)), 'utf8')).includes('first progress'), true);
 });

test('keeps changed history immutable and prompt stable', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  const one = await store.save({ ...sessions, progress: 'one' });
  const firstManifest = JSON.parse(await readFile(path.join(root, 'codex_1', 'dsh_1', 'manifest.json'), 'utf8'));
  const firstHistoryPath = path.join(root, 'codex_1', 'dsh_1', 'history', `${firstManifest.hash}.md`);
  assert.equal((await readFile(firstHistoryPath, 'utf8')).includes('one'), true);
  const second = await store.save({ ...sessions, progress: 'two' });
  assert.equal(second.revision, 2); assert.notEqual(one.codexPrompt, second.codexPrompt);
  assert.equal((await readFile(firstHistoryPath, 'utf8')).includes('one'), true);
  const history = await readdir(path.join(root, 'codex_1', 'dsh_1', 'history'));
  assert.equal(history.length, 2); assert.ok(history.every(name => /^[a-f0-9]{64}\.md$/.test(name)));
  assert.equal((await store.latest('codex_1', 'dsh_1')).manifest.revision, 2);
});

test('isolates multiple session pairs', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  await store.save({ ...sessions, progress: 'pair one' });
  await store.save({ codexSession: { ...sessions.codexSession, id: 'codex_2' }, dshSession: sessions.dshSession, progress: 'pair two' });
  assert.equal((await store.latest('codex_1', 'dsh_1')).content.includes('pair one'), true);
  assert.equal((await store.latest('codex_2', 'dsh_1')).content.includes('pair two'), true);
});

test('serializes concurrent duplicate saves', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  const results = await Promise.all(Array.from({ length: 12 }, () => store.save({ ...sessions, progress: 'same' })));
  assert.equal(new Set(results.map(result => result.revision)).size, 1);
  assert.equal((await readdir(path.join(root, 'codex_1', 'dsh_1', 'history'))).length, 1);
});

test('rejects unsafe ids, oversized or empty progress', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  await assert.rejects(() => store.save({ ...sessions, codexSession: { ...sessions.codexSession, id: '../escape' }, progress: 'x' }), /codexSession\.id/);
  await assert.rejects(() => store.save({ ...sessions, progress: 'x'.repeat(50001) }), /progress/);
  await assert.rejects(() => store.save({ ...sessions, progress: '' }), /progress/);
  await assert.rejects(() => store.latest('../escape', 'dsh_1'), /codexId/);
  await assert.rejects(() => store.latest('codex_1\n', 'dsh_1'), /codexId/);
});

test('rejects symlinked root parents and handoff directories', async () => {
  const base = await fixture(); const outside = await fixture();
  await symlink(outside, path.join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => new HandoffStore({ root: path.join(base, 'linked', 'handoffs') }).save({ ...sessions, progress: 'blocked' }), /unsafe|symlink|junction/);
  const root = await fixture();
  await symlink(outside, path.join(root, 'codex_1'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => new HandoffStore({ root }).save({ ...sessions, progress: 'blocked' }), /unsafe|symlink|junction/);
});

test('rejects corrupted latest or history instead of deduplicating', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  await store.save({ ...sessions, progress: 'value' });
  const latest = path.join(root, 'codex_1', 'dsh_1', 'latest.md');
  await writeFile(latest, 'corrupted');
  await assert.rejects(() => store.save({ ...sessions, progress: 'value' }), /integrity|mismatch/);
  await assert.rejects(() => store.latest('codex_1', 'dsh_1'), /integrity|mismatch/);
});

test('rejects corrupted manifest or history', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  await store.save({ ...sessions, progress: 'value' });
  const pair = path.join(root, 'codex_1', 'dsh_1');
  const manifestPath = path.join(pair, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, hash: '0'.repeat(64) }));
  await assert.rejects(() => store.save({ ...sessions, progress: 'value' }), /integrity|mismatch|ENOENT/);

  await writeFile(manifestPath, JSON.stringify(manifest));
  const restored = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(path.join(pair, 'history', `${restored.hash}.md`), 'corrupted history');
  await assert.rejects(() => store.latest('codex_1', 'dsh_1'), /mismatch|integrity/);
});

test('latest filters by both session ids', async () => {
  const root = await fixture(); const store = new HandoffStore({ root });
  await store.save({ ...sessions, progress: 'value' });
  assert.equal(await store.latest('codex_2', 'dsh_1'), null);
  assert.equal((await store.latest('codex_1', 'dsh_1')).content.includes('value'), true);
});
