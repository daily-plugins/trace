import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] ?? 'run';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function main() {
  if (!['init', 'doctor', 'run'].includes(action) || process.argv.length > 3) throw new Error('Usage: node scripts/tunnel.mjs <init|doctor|run>');
  if (process.platform === 'win32') throw new Error('This launcher supports macOS/Linux. See docs/tunnel-connection.md.');
  try { loadEnvFile(join(root, '.env.tunnel')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read .env.tunnel.'); }
  const profile = process.env.TRACE_TUNNEL_PROFILE ?? 'trace';
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid TRACE_TUNNEL_PROFILE.');
  const key = process.env.CONTROL_PLANE_API_KEY?.trim();
  if (!key || key.includes('REPLACE_WITH')) throw new Error('Set CONTROL_PLANE_API_KEY in .env.tunnel. See docs/tunnel-connection.md.');
  const configValue = process.env.TRACE_CONFIG ?? join(homedir(), '.config/trace/config.json');
  const config = resolve(root, configValue.startsWith('~/') ? join(homedir(), configValue.slice(2)) : configValue);
  for (const file of [join(root, 'dist/src/server.js'), join(root, 'scripts/tunnel-server.mjs')]) {
    try { await access(file, constants.R_OK); }
    catch { throw new Error('Missing server build or launcher. Run npm run build first.'); }
  }
  try { await access(config, constants.R_OK); }
  catch { throw new Error('Trace configuration is unavailable. Register an environment with npm run trace -- setup, or set TRACE_CONFIG.'); }
  let args;
  if (action === 'init') {
    const id = process.env.TRACE_TUNNEL_ID;
    if (!id || !/^tunnel_[a-zA-Z0-9]+$/.test(id) || id.includes('REPLACE')) throw new Error('Set TRACE_TUNNEL_ID to the Trace tunnel ID from Platform settings.');
    const command = [process.execPath, join(root, 'scripts/tunnel-server.mjs'), config].map(quote).join(' ');
    args = ['init', '--sample', 'sample_mcp_stdio_local', '--profile', profile,
      '--tunnel-id', id, '--mcp-command', command, '--health-listen-addr', '127.0.0.1:0'];
  } else args = [action, '--profile', profile, ...(action === 'doctor' ? ['--explain'] : [])];
  const child = spawn(process.env.TUNNEL_CLIENT_PATH || 'tunnel-client', args, {
    cwd: root, env: { ...process.env, TRACE_CONFIG: config }, stdio: 'inherit', shell: false,
  });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  }));
  const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  child.once('error', () => {
    cleanup(); console.error('Cannot start tunnel-client. Install the official binary or set TUNNEL_CLIENT_PATH.'); process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup(); process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
