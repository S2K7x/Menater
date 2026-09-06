/**
 * Reachability probes for the settings screen.
 *
 * Both answer the same question — "is the thing you just typed in actually
 * there?" — and both must fail with a sentence rather than a stack trace: the
 * person reading them is configuring, not debugging.
 */

import { createConnection } from 'node:net';

import { fetchWithDeadline } from './http.ts';

/** TCP reachability test. With no Postgres driver, this is what can be proven. */
export function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; detail: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    const done = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true, `Port ${port} is open on ${host}.`));
    socket.on('timeout', () => done(false, `No answer from ${host}:${port} within ${timeoutMs / 1000} s.`));
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const known: Record<string, string> = {
        ECONNREFUSED: 'Connection refused: nothing is listening on this port.',
        ENOTFOUND: 'Host not found: check the domain name.',
        EHOSTUNREACH: 'Host unreachable from this machine.',
        ETIMEDOUT: 'Timed out: firewall, or the host is switched off.',
      };
      done(false, known[e.code ?? ''] ?? e.message);
    });
  });
}

/**
 * `fetch` with a deadline, worded for the operator.
 *
 * These probes dial a host somebody has just typed into a settings field, so a
 * timeout has to name the host and the delay: "no answer from X in 20 s" is a
 * diagnosis, "AbortError" is not.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  return fetchWithDeadline(url, init, {
    timeoutMs,
    onTimeout: (u, ms) => new Error(`No answer from ${new URL(u).host} within ${ms / 1000} s.`),
  });
}
