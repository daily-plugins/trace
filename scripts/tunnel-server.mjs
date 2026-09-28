// The profile pins a non-secret config path instead of relying on inherited cwd/env.
import { isAbsolute } from 'node:path';

if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
  console.error('Expected one absolute Trace configuration path. Reinitialize the tunnel profile.');
  process.exitCode = 1;
} else {
  process.env.TRACE_CONFIG = process.argv[2];
  delete process.env.CONTROL_PLANE_API_KEY;
  await import('../dist/src/server.js');
}
