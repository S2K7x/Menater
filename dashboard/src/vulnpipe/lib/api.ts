/**
 * Client HTTP de l'API VulnPipe.
 *
 * Toute erreur est traduite : l'utilisateur cible ne doit jamais voir un code
 * de statut nu ou un message technique.
 */

import type { StepEvent } from '../components/ScanTimeline.tsx';
import type { SecurityReport } from '../components/ReportView.tsx';
import type { UsageReport } from '../components/UsagePanel.tsx';
import type { ProviderAvailability, ProviderSettings } from '../components/ProviderSwitcher.tsx';
import type { ScanEstimate } from '../components/EstimatePanel.tsx';
import { getCurrentLocale } from '../../i18n/context.tsx';
import { dictionary } from '../../i18n/dictionary.ts';

/** Messages du client HTTP, dans la langue courante. */
const errors = () => dictionary(getCurrentLocale()).errors;

/**
 * Prefixe de l'API VulnPipe DANS LA CONSOLE FUSIONNEE.
 *
 * Le moteur d'analyse reste un service a lui (port 4319) : l'API de la console
 * le relaie sous `/api/vulnpipe/*`. Le navigateur ne voit donc qu'une seule
 * origine — meme cookie de session, meme reverse-proxy, pas de CORS a ouvrir
 * pour un service qui lit des depots de code.
 */
const BASE = import.meta.env?.VITE_VULNPIPE_API_URL ?? '/api/vulnpipe';

export interface LaunchResponse {
  run_id: string;
  events_url: string;
  estimate: ScanEstimate | null;
  notes?: string[];
  plain_language_summary: string;
}

export interface EstimateResponse {
  estimate_id: string;
  expires_in_s: number;
  estimate: ScanEstimate;
  notes?: string[];
}

export interface ScanTarget {
  target: string;
  commit_sha?: string;
  mode: 'full_scan' | 'incremental_scan';
}

export interface RunSnapshot {
  run_id: string;
  /**
   * `interrupted` : le service s'est arrêté pendant ce scan. Ni réussi ni
   * échoué — jamais commencé à finir. Le confondre avec « en cours » ferait
   * attendre un rapport qui n'arrivera pas.
   */
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  events: StepEvent[];
  error: string | null;
  report: SecurityReport | null;
  usage: UsageReport | null;
  estimate: ScanEstimate | null;
  target: { kind: 'directory' | 'file' | 'github'; label: string } | null;
  effective_mode: 'full_scan' | 'incremental_scan' | null;
  routes_analyzed: number | null;
  routes_failed: number | null;
}

/** Un run vu de loin : ni ses événements, ni son rapport. */
export interface RunSummary {
  run_id: string;
  status: RunSnapshot['status'];
  started_at: string | null;
  target: string | null;
  findings: number | null;
  error: string | null;
}

export interface ScanSettings {
  bypassClaudeForHighConfidence: boolean;
  /** Nombre d'adresses examinées en même temps pendant l'analyse. */
  detectionConcurrency: number;
}

export interface ScanSettingsResponse {
  settings: ScanSettings;
  /** Bornes des trois zones, telles que le serveur les applique réellement. */
  thresholds: { reject_below: number; direct_alert_above: number };
  /**
   * Bornes acceptées par le serveur pour les réglages numériques.
   *
   * Lues plutôt que recopiées : un `max` écrit en dur dans l'interface
   * mentirait le jour où le serveur changerait le sien, et le champ
   * accepterait une valeur que le serveur refuse.
   */
  limits?: { concurrency: { min: number; max: number } };
  /** État des caches de verdicts, quand le service le renvoie. */
  cache?: CacheState;
}

/**
 * Ce que les caches contiennent et d'où ça vient.
 *
 * `restored` porte le résultat de la reprise au démarrage, `why` compris : un
 * cache qu'on croit chargé et qui ne l'est pas (fichier d'une autre version,
 * volume non monté) transforme un scan censé être gratuit en scan facturé,
 * sans que rien ne l'explique.
 */
export interface CacheState {
  persisted: boolean;
  restored: Array<{ kind: string; kept: number; dropped: number; why: string | null }>;
  detection: CacheCounters;
  arbitration: CacheCounters;
}

export interface CacheCounters {
  entries: number;
  hits: number;
  misses: number;
  expired: number;
}

/** Les variables de moteur que les Réglages ont le droit de renseigner. */
export type ManagedKey =
  | 'GEMINI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'VULNPIPE_LLM_BASE_URL';

export interface KeyStatus {
  name: ManagedKey;
  set: boolean;
  /**
   * `environment` : posée par le shell, Docker ou la CI. `store` : saisie
   * ici. `dotenv` : lue dans un fichier `.env`. `none` : absente.
   */
  source: 'environment' | 'store' | 'dotenv' | 'none';
  /** Posée par l'environnement : non modifiable depuis l'interface. */
  locked: boolean;
}

/** Erreur portant un message déjà lisible par un non-développeur. */
export class ApiError extends Error {
  readonly friendly: string;
  constructor(technical: string, friendly: string) {
    super(technical);
    this.name = 'ApiError';
    this.friendly = friendly;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new ApiError(
      (error as Error).message,
      errors().unreachable
    );
  }

  // Read as text first: `.json().catch(() => ({}))` turned an unreadable answer
  // into an EMPTY SUCCESS. A 200 carrying the SPA's `index.html` — the exact
  // trap the static fallback already produced once — would have been handed to
  // the caller as a valid, empty result, and shown as a scan that found nothing.
  const text = await response.text();
  let body: Record<string, unknown> = {};
  let unreadable = false;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      unreadable = true;
    }
  }

  if (!response.ok) {
    // A failing answer with a non-JSON body still reports its status: that is
    // more informative than saying the body was unreadable.
    throw new ApiError(
      String(body.error ?? `HTTP ${response.status}`),
      String(body.plain_language_summary ?? errors().generic)
    );
  }

  if (unreadable) {
    throw new ApiError(
      `HTTP ${response.status} with an unreadable body: ${text.slice(0, 120)}`,
      errors().unreadable
    );
  }
  return body as T;
}

export const api = {
  /**
   * Devis : ce que l'analyse va coûter, sans rien dépenser.
   *
   * Le serveur garde de côté le travail préparatoire (index, éventuel clone)
   * sous `estimate_id` : accepter le devis relance donc le scan sans tout
   * recommencer.
   */
  estimateScan(input: ScanTarget) {
    return request<EstimateResponse>('/estimate', {
      method: 'POST',
      body: JSON.stringify({ ...input, locale: getCurrentLocale() }),
    });
  },

  launchScan(input: ScanTarget & { estimate_id?: string }) {
    return request<LaunchResponse>('/webhook', {
      method: 'POST',
      body: JSON.stringify({ ...input, locale: getCurrentLocale() }),
    });
  },

  getRun(runId: string) {
    return request<RunSnapshot>(`/runs/${runId}`);
  },

  /** Les runs connus du service, du plus récent au plus ancien. */
  listRuns(limit = 20) {
    return request<{ runs: RunSummary[]; interrupted_at_startup: string[] }>(`/runs?limit=${limit}`);
  },

  getProviders() {
    return request<{ settings: ProviderSettings; available: ProviderAvailability[]; notes?: string[] }>(
      `/providers?locale=${getCurrentLocale()}`
    );
  },

  setProviders(next: Partial<ProviderSettings>) {
    return request<{ settings: ProviderSettings; available: ProviderAvailability[]; notes?: string[] }>(
      '/providers',
      { method: 'POST', body: JSON.stringify({ ...next, locale: getCurrentLocale() }) }
    );
  },

  /**
   * État des clés de moteur : posée ou absente, et d'où elle vient.
   *
   * AUCUNE VALEUR NE TRANSITE. Le serveur ne renvoie qu'un booléen et une
   * provenance — même discipline que les secrets de la console.
   */
  getProviderKeys() {
    return request<{ keys: KeyStatus[] }>('/provider-keys');
  },

  /**
   * Enregistre des clés. Prises en compte À CHAUD : la réponse porte la
   * disponibilité recalculée, donc le sélecteur de moteur se met à jour sans
   * qu'on ait rien redémarré.
   *
   * Champ vide (`''`) : conserve la clé existante. `null` : l'efface.
   */
  setProviderKeys(patch: Partial<Record<ManagedKey, string | null>>) {
    return request<{ keys: KeyStatus[]; available: ProviderAvailability[] }>(
      `/provider-keys?locale=${getCurrentLocale()}`,
      { method: 'PUT', body: JSON.stringify(patch) }
    );
  },

  /**
   * Réglages d'analyse (arbitrage) + seuils de confiance appliqués.
   *
   * Séparé de `/providers` : ce n'est pas le même objet de décision. Le
   * fournisseur dit AVEC QUOI on analyse, ceci dit CE QUI est envoyé à
   * l'arbitre payant.
   */
  getScanSettings() {
    return request<ScanSettingsResponse>('/settings');
  },

  /**
   * Oublie tout ce qui a été mémorisé — contenu et fichiers.
   *
   * Existe parce que la persistance a supprimé l'échappatoire : redémarrer le
   * service vidait les caches, ce n'est plus vrai. Sans ce geste, quelqu'un
   * qui soupçonne un verdict figé n'aurait aucun moyen de le vérifier.
   */
  forgetCache() {
    return request<{ cache: CacheState }>('/cache', { method: 'DELETE' });
  },

  setScanSettings(next: Partial<ScanSettings>) {
    return request<ScanSettingsResponse>('/settings', {
      method: 'POST',
      body: JSON.stringify({ ...next, locale: getCurrentLocale() }),
    });
  },

  /**
   * Ouvre le flux d'événements.
   *
   * `EventSource` plutôt qu'un `fetch` en boucle : la reconnexion automatique
   * est gérée par le navigateur, et le serveur rejoue l'historique à chaque
   * connexion — un utilisateur qui rafraîchit sa page ne perd pas la timeline.
   */
  streamEvents(
    runId: string,
    handlers: { onEvent: (event: StepEvent) => void; onEnd: () => void; onError: (message: string) => void }
  ): () => void {
    const source = new EventSource(`${BASE}/runs/${runId}/events`);

    source.onmessage = (message) => {
      try {
        handlers.onEvent(JSON.parse(message.data) as StepEvent);
      } catch {
        // Une trame illisible ne doit pas casser le suivi en cours.
      }
    };
    source.addEventListener('end', () => {
      source.close();
      handlers.onEnd();
    });
    source.onerror = () => {
      // `EventSource` déclenche aussi `onerror` à la fermeture normale du
      // flux : on ne signale une panne que si la connexion est réellement
      // perdue alors qu'on attendait encore des événements.
      if (source.readyState === EventSource.CLOSED) {
        handlers.onError(errors().streamLost);
      }
    };

    return () => source.close();
  },
};
