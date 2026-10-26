// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set, and
// undici reads that variable once at startup, so setting it from inside the process
// is too late. Behind a proxy this re-execs once with the variable in place; on a
// machine with no proxy configured it does nothing at all.

import { spawnSync } from 'node:child_process';

export function ensureProxyAware() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy || process.env.NODE_USE_ENV_PROXY) return;

  const res = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  process.exit(res.status ?? 1);
}
