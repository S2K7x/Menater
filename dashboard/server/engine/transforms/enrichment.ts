/**
 * 02-Enrichment — normalisation des trois sources externes.
 *
 * ============================================================================
 * LA SIMPLIFICATION LA PLUS NETTE DU PORTAGE
 *
 * Les trois nœuds `Normalize Shodan`, `Normalize AbuseIPDB` et
 * `Normalize VirusTotal` faisaient 3 × 20 lignes RIGOUREUSEMENT IDENTIQUES,
 * à la liste des champs près : même détection d'échec, même emballage, même
 * repli, même `catch`. Trois copies, donc trois endroits où corriger un défaut,
 * et — constaté en lisant — trois occasions de ne le corriger que deux fois.
 *
 * Ici : un normaliseur, trois tables de champs. Le comportement d'échec est
 * écrit UNE fois et vaut pour les trois, y compris pour une quatrième source
 * ajoutée demain.
 *
 * ============================================================================
 * TROIS ÉTATS, ET ILS NE SE CONFONDENT JAMAIS
 *
 *   `ok`          — la source a répondu, on a des données ;
 *   `skipped`     — on ne l'a pas interrogée (pas de hash, IP privée) ;
 *   `unavailable` — on l'a interrogée et ça a échoué.
 *
 * Les fondre en « pas de données » coûterait la garantie que le modèle sait
 * ce qu'il ne sait pas : le garde-fou G10 exige qu'une source indisponible
 * soit NOMMÉE dans le raisonnement. Une source non interrogée, elle, n'a pas à
 * l'être — ce n'est pas un trou dans la connaissance, c'est une question qu'on
 * n'avait pas à poser.
 * ============================================================================
 */

import { IDENTITY_FIELDS, OBSERVABLE_FIELDS, clip, missingFields, type AlertPayload, type EnrichedAlert, type Enrichment, type EnrichmentMeta, type Observables, type Severity, type SourceResult } from './domain.ts';

/** Empreintes reconnues dans un journal brut : SHA-256, SHA-1, MD5. */
const HASH_RE = /\b[a-fA-F0-9]{64}\b|\b[a-fA-F0-9]{40}\b|\b[a-fA-F0-9]{32}\b/;

/** Plages privées RFC 1918, bouclage et lien-local. */
const PRIVATE_RE = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

const HASH_TYPES: Record<number, 'md5' | 'sha1' | 'sha256'> = {
  32: 'md5', 40: 'sha1', 64: 'sha256',
};

export interface GuardResult {
  payload_ok: boolean;
  missing_fields: string[];
  has_hash: boolean;
  file_hash: string | null;
  file_hash_type: 'md5' | 'sha1' | 'sha256' | null;
  source_ip_is_private: boolean | null;
  payload: AlertPayload | null;
  raw_input: Record<string, unknown> | null;
}

/**
 * Garde d'entrée de 02. Ne lève jamais : elle pose `payload_ok`.
 *
 * Elle décide aussi CE QU'ON A LE DROIT D'INTERROGER : sans empreinte, pas
 * d'appel à VirusTotal ; sur une IP privée, pas d'appel à Shodan ni AbuseIPDB.
 * Interroger quand même donnerait trois « unavailable » indiscernables d'une
 * panne — et déclencherait G10 pour rien.
 */
export function guardEnrichmentPayload(input: unknown): GuardResult {
  const body = (input ?? {}) as Record<string, unknown>;
  // N1 — identity only. An alert with no source address is still an alert;
  // it is simply one we have nothing to ask Shodan about.
  const missing = missingFields(body, IDENTITY_FIELDS);
  const ok = missing.length === 0;

  const match = ok ? String(body.raw_log).match(HASH_RE) : null;
  const hash = match ? match[0].toLowerCase() : null;

  const observables = {} as Observables;
  for (const field of OBSERVABLE_FIELDS) {
    const v = body[field];
    observables[field] = v === undefined || v === null || String(v).trim() === ''
      ? null
      : String(v).trim();
  }

  return {
    payload_ok: ok,
    missing_fields: missing,
    has_hash: Boolean(hash),
    file_hash: hash,
    file_hash_type: hash ? (HASH_TYPES[hash.length] ?? null) : null,
    // THREE STATES, NOT TWO. `true` private, `false` public, `null` there was
    // no address at all. Collapsing the third into `false` would report a
    // missing address as a public one, and send the reputation sources looking
    // up nothing — the exact opposite of what the skip rule is for.
    source_ip_is_private:
      ok && observables.source_ip !== null ? PRIVATE_RE.test(observables.source_ip) : null,
    payload: ok
      ? {
          ...observables,
          alert_id: String(body.alert_id),
          rule_name: String(body.rule_name),
          severity: String(body.severity).toLowerCase() as Severity,
          timestamp: String(body.timestamp),
          raw_log: String(body.raw_log),
          source: String(body.source ?? 'generic'),
          extensions: (body.extensions as Record<string, unknown>) ?? {},
          ingested_at: (body.ingested_at as string | null) ?? null,
          source_workflow: '02-Enrichment',
          // Absent vaut `true` : l'absence de configuration ne peut pas
          // activer l'exécution.
          shadow_mode: body.shadow_mode === undefined ? true : body.shadow_mode === true,
        }
      : null,
    raw_input: ok ? null : body,
  };
}

/** Extrait les champs utiles d'une réponse réussie. Un par source. */
type FieldMapper = (body: Record<string, unknown>) => Record<string, unknown>;

const get = (o: unknown, key: string): unknown =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;

/** `undefined` devient `null` : « champ absent de la réponse » reste visible. */
const orNull = (v: unknown): unknown => (v === undefined ? null : v);
const arrayOr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const MAPPERS: Record<'shodan' | 'abuseipdb' | 'vt', { source: string; map: FieldMapper }> = {
  shodan: {
    source: 'shodan',
    map: (j) => ({
      ip: orNull(j.ip_str), org: orNull(j.org), isp: orNull(j.isp), asn: orNull(j.asn),
      country: orNull(j.country_name), city: orNull(j.city), os: orNull(j.os),
      open_ports: arrayOr(j.ports), hostnames: arrayOr(j.hostnames), tags: arrayOr(j.tags),
      last_update: orNull(j.last_update),
    }),
  },
  abuseipdb: {
    source: 'abuseipdb',
    map: (j) => {
      const d = (j.data ?? {}) as Record<string, unknown>;
      return {
        ip: orNull(d.ipAddress),
        abuse_confidence_score: orNull(d.abuseConfidenceScore),
        total_reports: orNull(d.totalReports),
        distinct_reporters: orNull(d.numDistinctUsers),
        country_code: orNull(d.countryCode), isp: orNull(d.isp),
        usage_type: orNull(d.usageType),
        is_whitelisted: orNull(d.isWhitelisted), is_tor: orNull(d.isTor),
        last_reported_at: orNull(d.lastReportedAt),
      };
    },
  },
  vt: {
    source: 'virustotal',
    map: (j) => {
      const a = (get(j.data, 'attributes') ?? {}) as Record<string, unknown>;
      const s = (a.last_analysis_stats ?? {}) as Record<string, unknown>;
      return {
        file_hash: orNull(get(j.data, 'id')),
        malicious: orNull(s.malicious), suspicious: orNull(s.suspicious),
        harmless: orNull(s.harmless), undetected: orNull(s.undetected),
        reputation: orNull(a.reputation),
        type_description: orNull(a.type_description),
        meaningful_name: orNull(a.meaningful_name),
        popular_threat_label: orNull(
          get(a.popular_threat_classification, 'suggested_threat_label'),
        ),
      };
    },
  },
};

/**
 * Normalise la réponse d'une source. UNE fonction pour les trois.
 *
 * Elle ne lève jamais : un échec d'API ne doit pas casser l'assemblage. C'était
 * déjà la règle sous n8n, mais elle y était écrite trois fois.
 */
export function normalizeSource(
  which: keyof typeof MAPPERS,
  response: unknown,
): SourceResult {
  const { source, map } = MAPPERS[which];
  const j = (response ?? {}) as Record<string, unknown>;

  // Non interrogée : ce n'est pas un échec, et ça ne doit pas le devenir.
  if (j.__skipped) return j.__skipped as SourceResult;

  const httpStatus = typeof j.status === 'number' ? j.status : null;
  const failed = Boolean(j.error) || j.__isError === true || (httpStatus !== null && httpStatus >= 400);
  if (failed) {
    const e = (j.error ?? {}) as Record<string, unknown>;
    return {
      status: 'unavailable',
      source,
      http_status: (e.httpCode ?? e.status ?? httpStatus ?? null) as number | null,
      reason: clip(e.message ?? e.description ?? 'request failed'),
    };
  }

  try {
    // Le corps utile est sous `body` quand il vient du nœud `http`, sinon
    // c'est la réponse elle-même — utile pour tester sans passer par le nœud.
    const payload = (j.body ?? j) as Record<string, unknown>;
    return { status: 'ok', source, ...map(payload) };
  } catch (err) {
    return { status: 'unavailable', source, reason: `unparseable response: ${clip(err instanceof Error ? err.message : err, 200)}` };
  }
}

/** Marque une source volontairement non interrogée, avec la raison. */
export const skipped = (source: string, reason: string): SourceResult => ({
  status: 'skipped', source, reason,
});

/**
 * Recombine les trois enrichissements avec le payload d'origine.
 *
 * Sous n8n, cette fonction allait rechercher le garde par
 * `$('Guard — Validate Payload').first()` — un appel par NOM de nœud, cassé
 * par un simple renommage. Ici le garde arrive en paramètre : c'est le graphe
 * qui l'y met, et il le désigne par identifiant.
 */
export function assembleEnriched(
  guard: GuardResult,
  sources: Partial<Enrichment>,
  now: () => Date = () => new Date(),
): EnrichedAlert {
  if (!guard.payload) {
    throw new Error(`Assembly asked for on an invalid payload: ${guard.missing_fields.join(', ')}`);
  }

  const absent = (source: string): SourceResult => ({
    status: 'unavailable', source, reason: 'branch produced no result',
  });

  const enrichment: Enrichment = {
    shodan: sources.shodan ?? absent('shodan'),
    abuseipdb: sources.abuseipdb ?? absent('abuseipdb'),
    vt: sources.vt ?? absent('virustotal'),
  };

  const entries = Object.entries(enrichment) as Array<[string, SourceResult]>;
  const withStatus = (s: string) => entries.filter(([, v]) => v.status === s).map(([k]) => k);

  const meta: EnrichmentMeta = {
    enriched_at: now().toISOString(),
    file_hash: guard.file_hash,
    file_hash_type: guard.file_hash_type,
    source_ip_is_private: guard.source_ip_is_private,
    sources_ok: withStatus('ok'),
    sources_skipped: withStatus('skipped'),
    sources_unavailable: withStatus('unavailable'),
    // `skipped` ne dégrade PAS : on n'avait pas de question à poser.
    degraded: entries.some(([, v]) => v.status === 'unavailable'),
  };

  return { ...guard.payload, source_workflow: '02-Enrichment', enrichment, enrichment_meta: meta };
}
