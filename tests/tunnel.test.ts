import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFile = promisify(execFileCallback);

test('tunnel launcher quotes paths, isolates profiles, preserves env precedence and propagates failures', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "trace tunnel's fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'dist/src'), { recursive: true });
  for (const script of ['tunnel.mjs', 'tunnel-server.mjs']) await copyFile(resolve('scripts', script), join(root, 'scripts', script));
  await writeFile(join(root, 'dist/src/server.js'), '');
  await writeFile(join(root, 'config.json'), '{"version":1,"environments":[]}');
  const output = join(root, 'calls.json');
  const fake = join(root, 'fake-client');
  await writeFile(fake, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({args:process.argv.slice(2),hasKey:!!process.env.CONTROL_PLANE_API_KEY,config:process.env.TRACE_CONFIG}));\n` +
    `if(process.env.TEST_WAIT){process.on('SIGTERM',()=>process.exit(23));process.stdout.write('ready');setInterval(()=>{},1000)}else process.exit(Number(process.env.TEST_EXIT||0));\n`, { mode: 0o700 });
  const env = { ...process.env, TUNNEL_CLIENT_PATH: fake, TEST_OUTPUT: output, TRACE_CONFIG: 'config.json',
    CONTROL_PLANE_API_KEY: 'fixture-secret', TRACE_TUNNEL_ID: 'tunnel_fixture123', TRACE_TUNNEL_PROFILE: 'fixture-trace' };
  const invoke = (action: string, overrides = {}) => execFile(process.execPath, [join(root, 'scripts/tunnel.mjs'), action], { cwd: tmpdir(), env: { ...env, ...overrides } });
  const calls = async () => JSON.parse(await readFile(output, 'utf8'));
  await invoke('init'); const init = await calls();
  assert.equal(init.hasKey, true); assert.equal(init.config, join(root, 'config.json'));
  assert.deepEqual(init.args.slice(0, 7), ['init', '--sample', 'sample_mcp_stdio_local', '--profile', 'fixture-trace', '--tunnel-id', 'tunnel_fixture123']);
  assert.deepEqual(init.args.slice(9), ['--health-listen-addr', '127.0.0.1:0']);
  assert.equal(JSON.stringify(init.args).includes('fixture-secret'), false);
  const decoded = await execFile('/bin/sh', ['-c', `set -- ${init.args[8]}; printf '%s\\n' "$@"`]);
  assert.deepEqual(decoded.stdout.trimEnd().split('\n'), [process.execPath, join(root, 'scripts/tunnel-server.mjs'), join(root, 'config.json')]);
  await invoke('doctor'); assert.deepEqual((await calls()).args, ['doctor', '--profile', 'fixture-trace', '--explain']);
  await invoke('run'); assert.deepEqual((await calls()).args, ['run', '--profile', 'fixture-trace']);
  await assert.rejects(invoke('run', { TEST_EXIT: '7' }), { code: 7 });
  await assert.rejects(invoke('init', { TRACE_TUNNEL_ID: 'invalid' }), /Set TRACE_TUNNEL_ID/);
  await assert.rejects(invoke('run', { TRACE_TUNNEL_PROFILE: '../vault' }), /Invalid TRACE_TUNNEL_PROFILE/);
  await assert.rejects(invoke('run', { CONTROL_PLANE_API_KEY: '' }), /Set CONTROL_PLANE_API_KEY/);
  await assert.rejects(invoke('run', { TRACE_CONFIG: 'missing.json' }), /configuration is unavailable/);
  await assert.rejects(invoke('run', { TUNNEL_CLIENT_PATH: join(root, 'missing') }), /Cannot start tunnel-client/);
  await writeFile(join(root, '.env.tunnel'), 'CONTROL_PLANE_API_KEY=file-fixture\nTRACE_TUNNEL_PROFILE=file-profile\n');
  const fileEnv: NodeJS.ProcessEnv = { ...env }; delete fileEnv.CONTROL_PLANE_API_KEY;
  await execFile(process.execPath, [join(root, 'scripts/tunnel.mjs'), 'run'], { env: fileEnv });
  assert.equal((await calls()).hasKey, true); assert.equal((await calls()).args[2], 'fixture-trace');
  const child = spawn(process.execPath, [join(root, 'scripts/tunnel.mjs'), 'run'], { env: { ...env, TEST_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await once(child.stdout!, 'data'); child.kill('SIGTERM');
  assert.equal((await exit)[0], 23);
});

test('tunnel server uses the pinned config and exposes the same MCP tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trace-tunnel-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, environments: [{ name: 'chosen', agent: 'codex', root }] }));
  const client = new Client({ name: 'tunnel-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/tunnel-server.mjs'), config], env: { TRACE_CONFIG: '/not-the-selected-config', CONTROL_PLANE_API_KEY: 'fixture-secret' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    const result = await client.callTool({ name: 'list_environments', arguments: {} });
    const content = result.content as { text: string }[];
    assert.equal(JSON.parse(content[0]!.text).environments[0].name, 'chosen');
  } finally { await client.close(); }
});
