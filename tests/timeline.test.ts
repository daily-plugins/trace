import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { extractTimeline } from '../src/timeline.js';
import type { Config } from '../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('default unified queries merge sources, omit inactive sources, isolate errors and separate current changes', async t => {
 const root = await mkdtemp(join(tmpdir(), 'trace-timeline-')); t.after(() => rm(root, { recursive: true, force: true }));
 const sessions = join(root, 'sessions'); await mkdir(sessions);
 const idle = join(root, 'idle'); await mkdir(idle);
 const session = (timestamp: string, id: string) => [
  { type: 'session_meta', timestamp, payload: { id } },
  { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture message' }] } },
 ].map(x => JSON.stringify(x)).join('\n');
 await writeFile(join(sessions, 'session.jsonl'), session('2026-09-29T02:00:00Z', 'active'));
 await writeFile(join(idle, 'session.jsonl'), session('2026-09-20T02:00:00Z', 'idle'));
 const repository = join(root, 'repo'); await mkdir(repository);
 const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-29T01:00:00Z', GIT_COMMITTER_DATE: '2026-09-29T01:00:00Z' } });
 git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
 await writeFile(join(repository, 'file.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'fixture');
 await writeFile(join(repository, 'file.txt'), 'after');
 const clean = join(root, 'clean'); await mkdir(clean); execFileSync('git', ['-C', clean, 'init', '-q']);
 const config: Config = { version: 1, environments: [{ name: 'agent', agent: 'codex', root: sessions }, { name: 'idle-agent', agent: 'codex', root: idle }], repositories: [{ name: 'repo', root: repository }, { name: 'idle-repo', root: clean }, { name: 'broken', root: join(root, 'missing') }] };
 const range = { from: '2026-09-29T00:00:00Z', to: '2026-09-30T00:00:00Z' };
 const result = await extractTimeline(config, range);
 assert.deepEqual(result.timeline.map(e => e.sourceType), ['git', 'agent']);
 assert.deepEqual(result.sources.map(s => s.name), ['agent', 'broken', 'repo']);
 assert.equal(result.currentChanges.length, 1); assert.equal(result.currentChanges[0]?.repository, 'repo');
 assert.equal((result.currentChanges[0]?.state as { changedAt: null }).changedAt, null);
 assert.equal(result.incomplete, true);
 assert.ok(!JSON.stringify(result).includes('idle-'));
 assert.ok(!JSON.stringify(result).includes('fixture message'));
 const page = await extractTimeline(config, { ...range, limit: 1 });
 assert.equal(page.nextOffset, 1);
 const page2 = await extractTimeline(config, { ...range, limit: 1, offset: 1 });
 assert.equal(page2.timeline[0]?.sourceType, 'agent'); assert.equal(page2.nextOffset, null);
 const onlyAgent = await extractTimeline(config, { ...range, repositories: [], includeText: true });
 assert.equal(onlyAgent.incomplete, false); assert.equal(onlyAgent.currentChanges.length, 0);
 assert.ok(JSON.stringify(onlyAgent).includes('fixture message'));
 const noWork = await extractTimeline(config, { ...range, environments: [], repositories: ['idle-repo'] });
 assert.deepEqual(noWork.sources, []); assert.deepEqual(noWork.currentChanges, []); assert.equal(noWork.incomplete, false);
 await assert.rejects(extractTimeline(config, { repositories: ['unknown'] }), /not configured/);
 await assert.rejects(extractTimeline(config, { from: range.to, to: range.from }), /before/);
 const defaultRange = await extractTimeline({ version: 1, environments: [], repositories: [] });
 assert.equal(Date.parse(defaultRange.range.to) - Date.parse(defaultRange.range.from), 86400000);
 assert.ok(defaultRange.diagnostics.includes('no_registered_sources'));
 const path = join(root, 'config.json'); await writeFile(path, JSON.stringify(config));
 const cli = spawnSync(process.execPath, [resolve('dist/src/cli.js'), '--config', path, '--from', range.from, '--to', range.to], { encoding: 'utf8' });
 assert.equal(cli.status, 2, cli.stderr); assert.equal(JSON.parse(cli.stdout).timeline.length, 2);
 const client = new Client({ name: 'timeline-test', version: '1' });
 try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/server.js')], env: { TRACE_CONFIG: path }, stderr: 'pipe' }));
  assert.ok((await client.listTools()).tools.some(t => t.name === 'trace_activity'));
  const response = await client.callTool({ name: 'trace_activity', arguments: range });
  assert.notEqual(response.isError, true);
  assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).timeline.length, 2);
 } finally { await client.close(); }
});
