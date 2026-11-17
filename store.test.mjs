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

test('separates injected context, titles from the first real prompt, and summarizes the list', async () => {
  const root = await fixture();
  const id = '55555555-5555-4555-8555-555555555555';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  await writeFile(file, meta(id) +
    response('c1', 'user', '# AGENTS.md instructions\n\n<INSTRUCTIONS>项目约定</INSTRUCTIONS>') +
    response('c2', 'user', '<environment_context>\n  <cwd>D:\\work</cwd>\n</environment_context>') +
    response('u1', 'user', '帮我查一下 CRM 数据') +
    response('a1', 'assistant', '好的，我先看表结构。'));
  const store = new MirrorStore({ root, pollMs: 15 });
  try {
    await store.start();
    const session = store.getSession(id);
    assert.equal(session.title, '帮我查一下 CRM 数据');
    assert.deepEqual(session.messages.map(m => m.injected), [true, true, false, false]);
    assert.equal(session.messageCount, 4);
    assert.equal(session.visibleCount, 2);
    assert.equal(session.injectedCount, 2);
    const listed = store.listSessions().find(s => s.id === id);
    assert.equal(listed.preview, '好的，我先看表结构。');
    assert.equal(listed.messages, undefined);
    assert.equal(listed.visibleCount, 2);
  } finally { await cleanup(root, store); }
});

test('falls back to the session id when only injected context exists', async () => {
  const root = await fixture();
  const id = '66666666-6666-4666-8666-666666666666';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  await writeFile(file, meta(id) + response('c1', 'user', '# AGENTS.md instructions\n\n<INSTRUCTIONS>只有上下文</INSTRUCTIONS>'));
  const store = new MirrorStore({ root, pollMs: 15 });
  try {
    await store.start();
    const session = store.getSession(id);
    assert.equal(session.title, id);
    assert.equal(session.visibleCount, 0);
    assert.equal(session.injectedCount, 1);
    assert.equal(session.preview, '');
  } finally { await cleanup(root, store); }
});

test('classifies internal Codex threads and hides their guardian prompts from the conversation', async () => {
  const root = await fixture();
  const write = async (id, payload, body) => {
    const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
    await writeFile(file, line({ timestamp: '2026-10-28T00:00:00.000Z', type: 'session_meta',
      payload: { id, cwd: 'C:\\work', ...payload } }) + body);
  };
  const review = '77777777-7777-4777-8777-777777777777';
  const sub = '88888888-8888-4888-8888-888888888888';
  const user = '99999999-9999-4999-8999-999999999999';
  await write(review, { thread_source: 'guardian_review', source: { subagent: 'r' } },
    response('g1', 'user', 'The following is the Codex agent history added since your last approval assessment. Continue.') +
    response('g2', 'assistant', '{"outcome":"allow"}'));
  await write(sub, { thread_source: 'subagent', source: { subagent: 's' } },
    response('s1', 'user', '检查依赖版本'));
  await write(user, { thread_source: 'user', source: 'vscode' },
    response('u1', 'assistant', '你好'));
  const store = new MirrorStore({ root, pollMs: 15 });
  try {
    await store.start();
    const reviewSession = store.getSession(review);
    assert.equal(reviewSession.kind, 'review');
    assert.equal(reviewSession.injectedCount, 1);
    assert.equal(reviewSession.visibleCount, 1);
    assert.equal(reviewSession.messages[0].injected, true);
    assert.match(reviewSession.title, /^自动审查会话 · 77777777/);
    assert.equal(store.getSession(sub).kind, 'subagent');
    assert.equal(store.getSession(sub).title, '检查依赖版本');
    assert.equal(store.getSession(user).kind, 'user');
    assert.equal(store.listSessions().filter(s => s.kind === 'user').length, 1);
  } finally { await cleanup(root, store); }
});

test('drops Codex attachment preambles but keeps the prompt that follows', async () => {
  const root = await fixture();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const file = path.join(root, 'sessions', '2026', '10', '28', `rollout-${id}.jsonl`);
  const preamble = '\n# Files mentioned by the user:\n\n## clipboard-a.png: C:/tmp/clipboard-a.png\nImage attachment: true\n\n';
  const image = '<image name=[Image #1] path="C:/tmp/clipboard-a.png">\n</image>\n\n';
  await writeFile(file, meta(id) +
    response('a1', 'user', preamble + image + '请把这张图里的表格录入系统') +
    response('a2', 'user', preamble + image) +
    response('a3', 'assistant', '收到'));
  const store = new MirrorStore({ root, pollMs: 15 });
  try {
    await store.start();
    const messages = store.getSession(id).messages;
    assert.deepEqual(messages.map(m => m.text), ['请把这张图里的表格录入系统', '收到']);
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
