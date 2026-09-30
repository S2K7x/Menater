/**
 * Relais vers le service VulnPipe.
 *
 * ============================================================================
 * POURQUOI UN RELAIS ET PAS UNE FUSION DES DEUX SERVEURS
 *
 * VulnPipe indexe du code avec tree-sitter, parle a des LLM locaux et tient
 * une file de scans. Le rapatrier dans cette API — qui n'a volontairement
 * aucune dependance — reviendrait a y importer tout l'arbre de dependances de
 * l'analyseur pour un gain nul : les deux services tournent tres bien cote a
 * cote.
 *
 * Ce qui est fusionne, c'est ce qui compte pour l'utilisateur : UNE interface,
 * UNE origine, UN verrou d'acces. Le navigateur ne voit que
 * `/api/vulnpipe/...` ; le fait qu'un second processus reponde derriere est un
 * detail d'exploitation.
 *
 * ============================================================================
 * DEUX POINTS QUI SE PAIENT CHER SI ON LES OUBLIE
 *
 *  1. LE FLUX D'EVENEMENTS (SSE) NE DOIT PAS ETRE BUFFERISE. Le suivi en
 *     direct d'un scan passe par `/runs/:id/events`. On relaie donc en
 *     streaming (`pipe`), jamais en accumulant la reponse, et on desactive
 *     Nagle : un evenement retenu quelques centaines de millisecondes donne
 *     une interface qui parait figee.
 *
 *  2. UN SERVICE ABSENT N'EST PAS UNE PANNE DE LA CONSOLE. Si VulnPipe ne
 *     tourne pas, on repond 503 avec un message qui dit quoi lancer — pas une
 *     trace `ECONNREFUSED` que l'utilisateur devra traduire lui-meme.
 * ============================================================================
 */

import { Agent, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Connexions non reutilisees vers l'amont.
 *
 * L'agent global de Node garde les sockets ouverts pour les reutiliser. Ce
 * comportement, excellent pour des requetes courtes, est un piege ici : le
 * flux SSE d'un scan est coupe brutalement des que l'utilisateur quitte la
 * page, et le socket rendu au pool dans cet etat empoisonne la requete
 * suivante — en pratique, un `400` a corps vide juste apres la fin d'un scan,
 * qui affichait « L'operation n'a pas pu aboutir » sur un scan pourtant
 * termine et complet.
 *
 * Un socket neuf par requete coute quelques millisecondes en local. Un rapport
 * correct annonce comme un echec coute la confiance dans l'outil.
 */
const agent = new Agent({ keepAlive: false });

/** Prefixe expose au navigateur. Tout ce qui suit est passe tel quel. */
export const VULNPIPE_PREFIX = '/api/vulnpipe';

/**
 * Adresse du service, relue a chaque appel : deplacer VulnPipe sur un autre
 * port ne doit pas demander de redemarrer la console.
 */
function target(): URL {
  const raw = process.env.VULNPIPE_API_URL ?? `http://localhost:${process.env.VULNPIPE_API_PORT ?? 4319}`;
  return new URL(raw);
}

export function isVulnPipePath(path: string): boolean {
  return path === VULNPIPE_PREFIX || path.startsWith(`${VULNPIPE_PREFIX}/`);
}

/**
 * The headers that describe ONE HOP rather than the message (RFC 9110 § 7.6.1).
 *
 * They speak about the connection they arrived on. Copying them to the other hop
 * lets one end decide something that is not its business, and the two directions
 * cost differently — see the comment at each call site.
 */
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization',
] as const;

function stripHopByHop(headers: Record<string, unknown>): void {
  for (const name of HOP_BY_HOP) delete headers[name];
}

export function proxyToVulnPipe(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const upstream = target();
  // Le prefixe est un artefact de la console : VulnPipe expose `/estimate`,
  // `/runs/...`, pas `/api/vulnpipe/estimate`.
  const path = (url.pathname.slice(VULNPIPE_PREFIX.length) || '/') + url.search;

  const headers = { ...req.headers };
  // `host` doit designer l'amont, et le cookie de session de la console n'a
  // rien a faire chez un service qui ne le connait pas.
  headers.host = upstream.host;
  delete headers.cookie;
  // On ne relaie pas de reponse compressee : rien ici ne la decompresserait.
  delete headers['accept-encoding'];

  // THE HEADERS THAT DESCRIBE ONE HOP MUST NOT TRAVEL TO THE NEXT.
  //
  // `Connection` and the fields it governs (RFC 9110 § 7.6.1) describe the
  // connection they arrived on, not the request. Copying them forwarded the
  // BROWSER's choice to a socket the browser knows nothing about — and the
  // browser's choice is always `keep-alive`, which is the exact opposite of
  // what the agent above was built to say. Measured: the upstream saw
  // `connection: keep-alive` on every relayed request, so `keepAlive: false`
  // governed only this side of the hop; VulnPipe held each socket open waiting
  // for a second request the agent will never send on it.
  //
  // It is also what HID the fourth way an answer can stop early. A service that
  // ends short of the `content-length` it announced has its socket dropped by
  // Node at once under `Connection: close` — and 1.5 s later under keep-alive,
  // i.e. only once the browser gave up, which is after the operator has.
  //
  // `transfer-encoding` goes too: the framing of the body we are about to write
  // is ours to declare, and `httpRequest` picks it from what we send.
  //
  // THE SAME RULE APPLIES TO THE ANSWER, and applying it to the request alone
  // is what made this worse rather than better. With the browser's
  // `keep-alive` gone, the upstream answers `connection: close` — which was
  // copied straight on to the browser, so the browser stopped reading the
  // chunked framing and took end-of-connection as end-of-body. A cut event
  // stream then arrived as a 200 with a body: the very confusion the cut below
  // exists to remove, rebuilt by the header that describes the OTHER hop.
  stripHopByHop(headers);

  const forwarded = httpRequest(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path,
      headers,
      agent,
    },
    (upstreamRes) => {
      const answer = { ...upstreamRes.headers };
      stripHopByHop(answer);
      res.writeHead(upstreamRes.statusCode ?? 502, {
        ...answer,
        // Un scan n'est jamais un contenu a mettre en cache.
        'Cache-Control': 'no-store',
      });

      // AN ANSWER THAT STOPPED HALFWAY MUST NOT LOOK LIKE ONE STILL ARRIVING.
      //
      // `pipe()` does not forward a failure of its SOURCE: it unpipes and
      // returns. So when the analysis service died mid-answer — out of memory
      // on a large repository, a container restart, a ctrl-C — the three
      // events that said so (`aborted`, then `error` with `ECONNRESET`, then
      // `close`) were all swallowed, and THIS response was left open: HTTP
      // 200, a truncated body, and no end. The report spun for ever and the
      // live timeline froze with no message.
      //
      // `close` fires on BOTH outcomes, so `complete` is not a guard bolted on
      // to this handler — it IS the handler's predicate. Measured on Node
      // 22.22.2 it is `true` on every whole answer (a report, a 204, a 304, a
      // HEAD, a 160 kB body arriving in twenty chunks, a stream closed normally
      // by a finished scan) and `false` on all four ways an answer can stop
      // early.
      //
      // Worth knowing before anybody "simplifies" it: removing the test is
      // green against every assertion in `vulnpipe.test.ts`, and that is not a
      // hole in them. Destroying a response `pipe()` has already ended is a
      // no-op on this Node — measured: `res.writableLength` is 0 by then,
      // because backpressure means the relay cannot finish reading the service
      // until the browser has absorbed everything, and the connection survives
      // for the next request either way. So the line buys nothing TODAY and is
      // kept because it states the condition truthfully rather than relying on
      // a graceful-destroy nicety nothing in the HTTP module promises.
      //
      // The head is already gone, so the status code can no longer say
      // anything; what is left is to fail the transfer the way the upstream
      // failed it, which is also what the browser would have seen with no relay
      // in between. Ending instead would write a terminating chunk and hand a
      // truncated body over as a whole one.
      upstreamRes.on('close', () => {
        if (upstreamRes.complete) return;
        res.destroy();
      });

      upstreamRes.pipe(res);
    },
  );

  // Nagle regrouperait les petites trames SSE : c'est exactement ce qu'il ne
  // faut pas sur un flux dont chaque trame est un evenement a afficher.
  forwarded.setNoDelay(true);

  forwarded.on('error', (err: NodeJS.ErrnoException) => {
    if (res.headersSent) return res.end();
    const where = `${upstream.origin}`;
    const detail = err.code === 'ECONNREFUSED'
      ? `Le service d'analyse de code ne repond pas sur ${where}. `
        + `Le demarrer : \`npm run serve\` dans le dossier VulnPipe, `
        + `ou \`npm run dev\` depuis la console pour lancer les deux.`
      : `Le service d'analyse de code est injoignable sur ${where} : ${err.message}`;
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // Le champ `error` est celui que lit le client VulnPipe : le message
    // arrive ainsi dans le bandeau de la section, pas dans la console du
    // navigateur.
    res.end(JSON.stringify({ error: detail, plain_language_summary: detail }));
  });

  // Si le client abandonne (onglet ferme, scan annule), on coupe l'amont :
  // sinon un flux SSE reste ouvert cote VulnPipe jusqu'a son propre timeout.
  res.on('close', () => forwarded.destroy());

  req.pipe(forwarded);
}
