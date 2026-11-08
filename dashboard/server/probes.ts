/**
 * Reachability probe for the settings screen.
 *
 * It answers one question — "is the thing you just typed in actually there?" —
 * and it must fail with a sentence rather than a stack trace: the person
 * reading it is configuring, not debugging.
 *
 * IT USED TO SAY "BOTH". Beside it sat `fetchWithTimeout`, an HTTP probe
 * wrapping `fetchWithDeadline` with a worded timeout, and it had no caller
 * anywhere — nor a test, nor a mention outside its own declaration. The two
 * HTTP probes this console actually runs (Health's ingestion-endpoint check,
 * Settings' MCP self-test) both dial THIS process over the loopback, so naming
 * the host in their timeout would add nothing, and both take the sentence
 * `describeFetchError` gives them. The worded timeout the dead wrapper existed
 * to produce is right here in `tcpProbe`, which is the one probe that dials an
 * address somebody typed.
 */

import { createConnection } from 'node:net';

/**
 * TCP reachability test. With no Postgres driver, this is what can be proven.
 *
 * `port` MUST already be a whole number in [1, 65535]: `createConnection`
 * throws `ERR_SOCKET_BAD_PORT` SYNCHRONOUSLY, from inside the executor below,
 * for anything else. That check belongs to the CALLER and not here, because
 * the two questions have different answers: "is something listening" is a
 * verdict about the network and leaves as a 200, "that is not a port" is a
 * verdict about the request and leaves as a 400. Guarding it here would have
 * to return `ok: false`, which is the first answer given to the second
 * question — the confident wrong diagnosis this function was fixed for.
 */
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
