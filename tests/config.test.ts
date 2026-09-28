import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEnvironment, loadConfig, selectEnvironment } from '../src/config.js';

test('setup is explicit, persistent, isolated and refuses accidental replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const root = join(dir, 'sessions'); await mkdir(root);
  assert.deepEqual((await loadConfig(path)).environments, []);
  await addEnvironment({ name: 'work', agent: 'claude-code', root }, path);
  const config = await loadConfig(path);
  assert.throws(() => selectEnvironment(config), /explicitly/);
  assert.throws(() => selectEnvironment(config, 'other'), /not configured/);
  assert.equal(selectEnvironment(config, 'work').agent, 'claude-code');
  await assert.rejects(addEnvironment({ name: 'work', agent: 'codex', root }, path), /already exists/);
  await addEnvironment({ name: 'work', agent: 'antigravity', root }, path, true);
  assert.equal(selectEnvironment(await loadConfig(path), 'work').agent, 'antigravity');
  assert.equal((await readFile(path, 'utf8')).includes('version'), true);
});

test('invalid config and unavailable roots never fall back to another agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{broken');
  await assert.rejects(loadConfig(path), /Invalid/);
  await assert.rejects(addEnvironment({ name: 'work', agent: 'codex', root: join(dir, 'missing') }, path), /existing directory/);
});
