import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MirrorStore } from './store.mjs';

const line = value => JSON.stringify(value) + '\n';
const meta = (id, cwd = 'C:\\work', timestamp = '2026-10-28T00:00:00.000Z') =>
  line({ timestamp, type: 'session_meta', payload: { id, cwd, timestamp } });
const response = (id, role, text, timestamp = '2026-10-28T00:00:01.000Z') =>
  line({ timestamp, type: 'response_item', payload: { type: 'message', id, role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const event = (type, text, id, timestamp = '2026-10-28T00:00:02.000Z') =>
  line({ timestamp, type: 'event_msg', payload: { type, id, message: text } });
const waitFor = async (predicate, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for fixture update');
};

async function fixture() {
  const root = await mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), '.fixture-'));
  await mkdir(path.join(root, 'sessions', '2026', '10', '28'), { recursive: true });
  await mkdir(path.join(root, 'archived_sessions'), { recursive: true });
  return root;
}

async function cleanup(root, store) {
  await store?.stop();
  await rm(root, { recursive: true, force: true });
}

test('loads metadata, titles, messages, status, and ignores tool/developer content', async () => {
  const root = await fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  await writeFile(path.join(root, 'session_index.jsonl'), line({ id, thread_name: '中文标题', updated_at: '2026-10-28T00:00:03.000Z' }));
  await writeFile(file, meta(id) + response('m1', 'user', '你好') +
    line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: 'skip' }] } }) +
    line({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
    response('m2', 'assistant', '你好，世界') + event('task_completed', '', 'done'));
  const store = new MirrorStore({ root, pollMs: 15 });
  try {
    await store.start();
    const session = store.getSession(id);
    assert.equal(session.title, '中文标题');
    assert.equal(session.cwd, 'C:\\work');
    assert.equal(session.status, 'idle');
    assert.deepEqual(session.messages.map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: '你好' }, { role: 'assistant', text: '你好，世界' }]);
  } finally { await cleanup(root, store); }
});

test('handles UTF-8 half-lines, append, and event/response deduplication', async () => {
  const root = await fixture();
  const id = '22222222-2222-4222-8222-222222222222';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  await writeFile(path.join(root, 'session_index.jsonl'), line({ id, thread_name: '增量' }));
  await writeFile(file, meta(id) + response('same', 'user', '半行中文').slice(0, -1));
  const store = new MirrorStore({ root, pollMs: 10 });
  try {
    await store.start();
    assert.equal(store.getSession(id).messages.length, 0);
    await appendFile(file, '\n' + event('user_message', '半行中文', 'same') + response('same', 'user', '半行中文') + event('agent_message', '答复', 'a1') + response('a1', 'assistant', '答复'));
    await waitFor(() => store.getSession(id)?.messages.length === 2);
    assert.deepEqual(store.getSession(id).messages.map(m => m.text), ['半行中文', '答复']);
  } finally { await cleanup(root, store); }
});

test('reparses truncation and discovers new sessions while polling', async () => {
  const root = await fixture();
  const id = '33333333-3333-4333-8333-333333333333';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  await writeFile(file, meta(id) + response('old', 'user', '旧内容'));
  const store = new MirrorStore({ root, pollMs: 10 });
  try {
    await store.start();
    assert.equal(store.getSession(id).messages[0].text, '旧内容');
    await writeFile(file, meta(id, 'D:\\new', '2026-10-28T01:00:00.000Z') + response('new', 'user', '新内容'));
    await waitFor(() => store.getSession(id)?.messages[0].text === '新内容');
    const id2 = '44444444-4444-4444-8444-444444444444';
    const file2 = path.join(root, 'archived_sessions', `rollout-${id2}.jsonl`);
    await writeFile(file2, meta(id2) + response('a', 'assistant', '归档'));
    await waitFor(() => store.getSession(id2));
    assert.equal(store.getSession(id2).status, 'archived');
    assert.equal(store.listSessions().length, 2);
  } finally { await cleanup(root, store); }
});
