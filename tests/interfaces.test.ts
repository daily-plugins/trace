import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('CLI registers each agent and requires environment selection; MCP uses the same config', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'trace-interface-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = join(temp, 'config.json');
  const root = join(temp, 'codex'); await mkdir(root);
  await writeFile(join(root, 'test.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-28T00:00:00Z', payload: { id: 'fixture' } },
    { type: 'response_item', timestamp: '2026-09-28T00:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
  ].map(r => JSON.stringify(r)).join('\n'));
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli.js'), ...args, '--config', config], { encoding: 'utf8' });
  assert.equal(cli('sessions').status, 1);
  for (const agent of ['codex', 'claude-code', 'antigravity']) {
    assert.equal(cli('setup', '--environment', agent, '--agent', agent, '--root', root).status, 0);
  }
  assert.equal(JSON.parse(cli('environments').stdout).environments.length, 3);
  const extracted = cli('extract', '--environment', 'codex', '--include-text');
  assert.equal(extracted.status, 0); assert.equal(JSON.parse(extracted.stdout).events[0].text, 'hello');
  assert.equal(cli('extract', '--environment', 'antigravity').status, 2);
  const client = new Client({ name: 'trace-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/server.js')], env: { TRACE_CONFIG: config }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 5);
    const sessions = await client.callTool({ name: 'list_local_sessions', arguments: { environment: 'codex' } });
    assert.notEqual(sessions.isError, true);
    const content = sessions.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0]!.text).sessions[0].id, 'fixture');
    assert.equal(JSON.parse(content[0]!.text).events, undefined);
    assert.match(client.getInstructions() ?? '', /own conversation history/);
    const tools = (await client.listTools()).tools;
    assert.match(tools.find(tool => tool.name === 'trace_activity')!.description!, /host's own conversations are not included/);
    const activity = await client.callTool({ name: 'trace_activity', arguments: { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z' } });
    const activityResult = JSON.parse((activity.content as { text: string }[])[0]!.text);
    assert.equal(activityResult.timeline[0].source, 'codex');
    assert.deepEqual(activityResult.hostConversations.range, { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z' });
    assert.equal(activityResult.hostConversations.includedInResult, false);
    assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name), ['activity_review']);
    const prompt = await client.getPrompt({ name: 'activity_review', arguments: { period: 'this week', timezone: 'Asia/Seoul' } });
    const promptText = (prompt.messages[0]!.content as { text: string }).text;
    assert.equal(prompt.messages[0]!.role, 'user');
    assert.match(promptText, /what I did this week\. Use the Asia\/Seoul timezone/);
    assert.match(promptText, /trace_activity/); assert.match(promptText, /conversation history in this app/);
    const cliTimeline = JSON.parse(cli('timeline', '--from', '2026-09-28T00:00:00Z', '--to', '2026-09-29T00:00:00Z').stdout);
    assert.equal(cliTimeline.hostConversations, undefined);
    const missing = await client.callTool({ name: 'extract_local_events', arguments: { environment: 'unregistered' } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); }
});
