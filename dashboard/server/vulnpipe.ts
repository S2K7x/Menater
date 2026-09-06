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
      res.writeHead(upstreamRes.statusCode ?? 502, {
        ...upstreamRes.headers,
        // Un scan n'est jamais un contenu a mettre en cache.
        'Cache-Control': 'no-store',
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
