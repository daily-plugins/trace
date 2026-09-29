import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRepositories } from '../src/discovery.js';
import { addEnvironment, addRepository, loadConfig } from '../src/config.js';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function init(root: string) { await mkdir(root, { recursive: true }); git(root, 'init', '-q'); }

test('discovery previews and atomically registers directories, nested repositories and worktree git files', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'trace-discover-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'projects'); await mkdir(root);
  const first = join(root, 'a', 'app'); const second = join(root, 'b', 'app');
  const hidden = join(root, '.github'); const nested = join(first, 'nested');
  for (const path of [first, second, hidden, nested]) await init(path);
  git(first, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'initial');
  const worktree = join(root, 'worktree'); git(first, 'worktree', 'add', '-q', '-b', 'fixture-worktree', worktree);
  await init(join(root, 'node_modules', 'ignored'));
  await symlink(second, join(root, 'linked-directory'));
  const config = join(temp, 'config.json');
  const preview = await discoverRepositories({ root, config });
  assert.equal(preview.incomplete, false, JSON.stringify(preview.diagnostics));
  assert.equal(preview.discovered, 5); assert.equal(preview.added, 0);
  assert.deepEqual(preview.repositories.map(r => r.name).sort(), ['app', 'app-2', 'github', 'nested', 'worktree']);
  await assert.rejects(access(config));
  await addEnvironment({ name: 'codex', agent: 'codex', root }, config);
  await addRepository({ name: 'custom', root: first }, config);
  const canonicalFirst = await realpath(first);
  const result = await discoverRepositories({ root, config, register: true });
  assert.equal(result.added, 4); assert.equal(result.repositories.find(r => r.root === canonicalFirst)?.name, 'custom');
  assert.equal(result.repositories.find(r => r.root === canonicalFirst)?.status, 'existing');
  const saved = await readFile(config, 'utf8');
  assert.equal((await loadConfig(config)).environments[0]?.name, 'codex');
  assert.equal((await discoverRepositories({ root, config, register: true })).added, 0);
  assert.equal(await readFile(config, 'utf8'), saved);
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'discover-git', '--config', config, ...args], { encoding: 'utf8' });
  assert.equal(cli().status, 1);
  assert.equal(cli('--root', root, '--replace').status, 1);
  const listed = cli('--root', root, '--register');
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).discovered, 5);
  await writeFile(`${config}.lock`, '');
  await assert.rejects(discoverRepositories({ root, config, register: true }), /locked/);
  assert.equal(await readFile(config, 'utf8'), saved);
});

test('discovery reports invalid markers and bounds without following symlinks', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'trace-discover-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'projects'); await init(root);
  await init(join(root, 'child')); await init(join(root, 'other'));
  const config = join(temp, 'config.json');
  const shallow = await discoverRepositories({ root, config, maxDepth: 0 });
  assert.equal(shallow.discovered, 1); assert.ok(shallow.diagnostics.some(d => d.code === 'depth_limit'));
  const limited = await discoverRepositories({ root, config, maxRepositories: 1, register: true });
  assert.equal(limited.added, 1); assert.ok(limited.diagnostics.some(d => d.code === 'repository_limit'));
  assert.ok((await discoverRepositories({ root, config, maxEntries: 1 })).diagnostics.some(d => d.code === 'entry_limit'));
  await mkdir(join(root, 'bad')); await writeFile(join(root, 'bad', '.git'), 'invalid');
  await mkdir(join(root, 'link')); await symlink(join(root, '.git'), join(root, 'link', '.git'));
  const bad = await discoverRepositories({ root, config });
  assert.ok(bad.diagnostics.some(d => d.code === 'invalid_git_repository'));
  assert.ok(bad.diagnostics.some(d => d.code === 'symlink_git_marker'));
  assert.equal(bad.discovered, 3);
  await assert.rejects(discoverRepositories({ root, config, maxDepth: -1 }));
  await assert.rejects(discoverRepositories({ root: join(temp, 'missing'), config }), /existing directory/);
});
