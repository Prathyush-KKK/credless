// The worker shim's policy: pure functions and the one environment name, importable without the shim's side effect
// (the CLI and global setup set the variable; the shim reads it). See worker-shim.ts for what the shim does.
import { ENV_PREFIX } from '../brand.ts';

/**
 * Proposed `ENV.WORKER_PROXY_URL`: `off` or unset leaves the shim inert; `loopback` turns the guard on with no proxy
 * (v0.1: global setup sets this for the workers); a URL allows that proxy too and publishes it as the env proxy.
 */
export const WORKER_PROXY_ENV = `${ENV_PREFIX}WORKER_PROXY_URL`;

export interface ShimPolicy {
  /** the proxy's host and port, allowed besides loopback */
  proxy: { host: string; port: number } | null;
}

/** Loopback by address or by the one name that always resolves to it. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.startsWith('::ffff:')) return isLoopback(h.slice(7));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** What the environment asks for: null when the shim stays inert. */
export function policyFrom(value: string | undefined): ShimPolicy | null {
  if (!value || value === 'off') return null;
  if (value === 'loopback') return { proxy: null };
  try {
    const url = new URL(value);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return { proxy: { host: url.hostname.replace(/^\[|\]$/g, ''), port } };
  } catch {
    return null;
  }
}

/** Whether a destination may be dialled under the policy. */
export function allowed(policy: ShimPolicy, host: string, port: number): boolean {
  if (isLoopback(host)) return true;
  return policy.proxy !== null && policy.proxy.host.toLowerCase() === host.toLowerCase() && policy.proxy.port === port;
}
