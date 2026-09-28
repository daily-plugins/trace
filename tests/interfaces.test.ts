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
    assert.equal((await client.listTools()).tools.length, 3);
    const sessions = await client.callTool({ name: 'list_local_sessions', arguments: { environment: 'codex' } });
    assert.notEqual(sessions.isError, true);
    const content = sessions.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0]!.text).sessions[0].id, 'fixture');
    assert.equal(JSON.parse(content[0]!.text).events, undefined);
    const missing = await client.callTool({ name: 'extract_local_events', arguments: { environment: 'unregistered' } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); }
});
