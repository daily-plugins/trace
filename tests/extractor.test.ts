import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalSessionAdapter, bounds, unionMs } from '../src/extractor.js';
import type { Agent } from '../src/config.js';

async function fixture(t: TestContext, agent: Agent, records: unknown[], name = 'session.jsonl') {
  const root = await mkdtemp(join(tmpdir(), 'trace-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, name); await mkdir(dirname(file), { recursive: true });
  const original = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(file, original);
  return { root, file, original, adapter: new LocalSessionAdapter({ name: 'test', agent, root }) };
}
const at = (minute: number) => `2026-09-28T00:${String(minute).padStart(2, '0')}:00Z`;
const meta = { timestamp: at(0), type: 'session_meta', payload: { id: 'session-a', cwd: '/project' } };
const turn = (type: string, minute: number, id = 'turn-1') => ({ timestamp: at(minute), type: 'event_msg', payload: { type, turn_id: id } });
const msg = (role: string, minute: number, text: string) => ({ timestamp: at(minute), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('Codex extracts canonical messages, evidence and bounded opt-in text without changing files', async t => {
  const f = await fixture(t, 'codex', [meta, turn('task_started', 1),
    { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'request' } },
    msg('user', 1, 'request'), msg('assistant', 2, 'done'),
    { timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'tool-1', arguments: 'SECRET' } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'reasoning', summary: 'PRIVATE' } },
    turn('task_complete', 3), msg('user', 4, 'x'.repeat(5000))]);
  const r = await f.adapter.extract();
  assert.equal(r.incomplete, false); assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0]?.counts.user_message, 2);
  assert.equal(r.sessions[0]?.turnExecutionMs, 120000);
  assert.equal(r.events.some(e => 'text' in e), false);
  const detailed = await f.adapter.extract({ includeText: true });
  assert.equal(detailed.events.find(e => e.text?.startsWith('xxx'))?.text?.length, 4000);
  assert.equal(detailed.events.at(-1)?.textTruncated, true);
  assert.equal(JSON.stringify(detailed).includes('SECRET'), false);
  assert.equal(JSON.stringify(detailed).includes('PRIVATE'), false);
  assert.equal(detailed.events.find(e => e.kind === 'user_message')?.evidence.line, 4);
  assert.equal(await readFile(f.file, 'utf8'), f.original);
});

test('range clips overlapping turns and finds resumed activity in older directory names', async t => {
  const f = await fixture(t, 'codex', [meta, turn('task_started', 1), turn('task_complete', 9), msg('user', 10, 'outside')], '2025/01/01/old.jsonl');
  const r = await f.adapter.extract({ from: '2026-09-28T09:03:00+09:00', to: '2026-09-28T09:05:00+09:00' });
  assert.equal(r.events.length, 0); assert.equal(r.sessions.length, 1);
  assert.equal(r.metrics.turnExecutionUnionMs, 120000);
  const boundary = await f.adapter.extract({ from: at(9), to: at(10) });
  assert.deepEqual(boundary.events.map(e => e.kind), ['turn_completed']);
});

test('concurrent session wall times use a union; summed durations remain separate', async t => {
  const f = await fixture(t, 'codex', [meta, turn('task_started', 1), turn('task_complete', 5)]);
  await writeFile(join(f.root, 'b.jsonl'), [
    { ...meta, payload: { id: 'session-b' } }, turn('task_started', 3), turn('task_complete', 7),
  ].map(r => JSON.stringify(r)).join('\n'));
  const r = await f.adapter.extract();
  assert.equal(r.metrics.summedSessionTurnExecutionMs, 480000);
  assert.equal(r.metrics.turnExecutionUnionMs, 360000);
});

test('open turns are not extrapolated, aborted turns are bounded, legacy messages survive', async t => {
  const f = await fixture(t, 'codex', [meta, turn('task_started', 1), turn('turn_aborted', 2), turn('task_started', 3, 'open'),
    { timestamp: at(4), type: 'event_msg', payload: { type: 'agent_message', message: 'legacy' } }]);
  const r = await f.adapter.extract({ includeText: true });
  assert.equal(r.sessions[0]?.openTurns, 1); assert.equal(r.sessions[0]?.turnExecutionMs, 60000);
  assert.equal(r.events.at(-1)?.text, 'legacy');
});

test('Claude Code distinguishes text, tools, results, thinking and subagents', async t => {
  const rows = [
    { type: 'user', sessionId: 'parent', uuid: 'u1', cwd: '/project', timestamp: at(0), message: { content: 'fix it' } },
    { type: 'assistant', sessionId: 'parent', uuid: 'a1', timestamp: at(1), message: { model: 'fixture-model', content: [
      { type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'done' }, { type: 'tool_use', id: 'call-1', name: 'Read', input: { secret: 'SECRET' } },
    ] } },
    { type: 'user', sessionId: 'parent', timestamp: at(2), message: { content: [{ type: 'tool_result', content: 'RESULT' }] } },
    { type: 'user', sessionId: 'parent', isMeta: true, timestamp: at(3), message: { content: 'INJECTED' } },
  ];
  const f = await fixture(t, 'claude-code', [...rows, rows[1]]);
  const r = await f.adapter.extract({ includeText: true });
  assert.equal(r.events.length, 3); assert.equal(r.sessions[0]?.counts.user_message, 1);
  assert.equal(r.sessions[0]?.model, 'fixture-model'); assert.equal(r.sessions[0]?.turnExecutionMs, null);
  assert.equal(r.metrics.sessionsWithoutTiming, 1);
  for (const secret of ['PRIVATE', 'SECRET', 'RESULT', 'INJECTED']) assert.equal(JSON.stringify(r).includes(secret), false);
  const sub = join(f.root, 'parent/subagents/agent-xyz.jsonl'); await mkdir(dirname(sub), { recursive: true });
  await writeFile(sub, JSON.stringify(rows[0]));
  const both = await f.adapter.extract();
  assert.deepEqual(new Set(both.sessions.map(s => s.id)), new Set(['parent', 'parent/agent-xyz']));
});

test('Antigravity native transcripts expose message/tool steps and no fabricated execution duration', async t => {
  const f = await fixture(t, 'antigravity', [
    { type: 'USER_INPUT', created_at: at(1), step_index: 0, status: 'DONE', content: 'build feature' },
    { type: 'PLANNER_RESPONSE', created_at: at(2), step_index: 1, status: 'DONE', content: 'implemented', thinking: 'PRIVATE', tool_calls: [{ name: 'run_command', args: { secret: 'SECRET' } }] },
    { type: 'GENERIC', created_at: at(3), step_index: 2, content: 'OUTPUT' },
    { type: 'SYSTEM_MESSAGE', created_at: at(3), step_index: 3, content: 'INJECTED' },
  ], 'conversation-1/.system_generated/logs/transcript.jsonl');
  await writeFile(join(f.root, 'unrelated.jsonl'), 'not a transcript');
  const r = await f.adapter.extract({ includeText: true });
  assert.equal(r.incomplete, false); assert.equal(r.sessions[0]?.id, 'conversation-1');
  assert.equal(r.events.length, 3); assert.equal(r.events[2]?.tool, 'run_command');
  assert.equal(r.metrics.turnExecutionUnionMs, null);
  assert.equal(r.sessions[0]?.observedSpanMs, 120000);
  for (const secret of ['PRIVATE', 'SECRET', 'OUTPUT', 'INJECTED']) assert.equal(JSON.stringify(r).includes(secret), false);
});

test('malformed tails and unsupported formats report incomplete results, not fabricated data', async t => {
  const f = await fixture(t, 'codex', [meta, msg('user', 1, 'valid')]);
  await writeFile(f.file, `${f.original}{partial`);
  let r = await f.adapter.extract();
  assert.equal(r.events.length, 1); assert.equal(r.incomplete, true);
  assert.equal(r.diagnostics[0]?.code, 'malformed_jsonl');
  await writeFile(f.file, JSON.stringify({ unknown: true }));
  r = await f.adapter.extract();
  assert.equal(r.sessions.length, 0); assert.equal(r.diagnostics[0]?.code, 'unsupported_format');
});

test('registered roots are isolated; symlinked transcripts are not followed', async t => {
  const a = await fixture(t, 'codex', [meta, msg('user', 1, 'A')]);
  const b = await fixture(t, 'codex', [{ ...meta, payload: { id: 'other' } }, msg('user', 1, 'B')]);
  await symlink(b.file, join(a.root, 'external.jsonl'));
  const r = await a.adapter.extract({ includeText: true });
  assert.equal(r.sessions.length, 1); assert.equal(r.events[0]?.text, 'A');
});

test('pagination is stable on unchanged files, and IDs differ between environments', async t => {
  const f = await fixture(t, 'codex', [meta, msg('user', 1, 'one'), msg('assistant', 2, 'two')]);
  const first = await f.adapter.extract({ limit: 1 });
  const second = await f.adapter.extract({ offset: first.nextOffset!, limit: 1 });
  assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, null);
  assert.notEqual(first.events[0]?.id, second.events[0]?.id);
  const another = await new LocalSessionAdapter({ name: 'different', agent: 'codex', root: f.root }).extract();
  assert.notEqual(first.events[0]?.id, another.events[0]?.id);
});

test('query validation rejects ambiguous dates and invalid pagination', () => {
  for (const q of [{ from: '' }, { from: '2026-09-28' }, { from: at(2), to: at(1) }, { limit: 0 }, { limit: 1001 }, { offset: -1 }]) assert.throws(() => bounds(q));
  assert.equal(unionMs([[0, 10], [5, 15], [20, 30]]), 25);
});
