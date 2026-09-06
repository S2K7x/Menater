/**
 * Ce qui se passe MAINTENANT, pendant l'analyse.
 *
 * ============================================================================
 * POURQUOI CE COMPOSANT EXISTE À CÔTÉ DE LA TIMELINE
 *
 * La timeline répond à « où en est-on ? » : sept étapes, une ligne chacune.
 * Elle est juste, et elle est ennuyeuse — pendant les minutes que dure la
 * détection, elle n'affiche qu'une barre qui avance.
 *
 * Or c'est exactement là que se joue la confiance dans l'outil. Un scan de
 * sécurité qui tourne trois minutes en silence ressemble à un logiciel bloqué.
 * Le même scan qui montre l'adresse en cours d'examen, les verdicts qui
 * tombent un par un et le compteur de dépense qui grimpe ressemble à quelqu'un
 * qui travaille pour toi.
 *
 * Ce panneau montre donc trois choses que la timeline ne peut pas montrer :
 *   1. l'adresse en cours d'examen, nommée ;
 *   2. le fil des verdicts déjà rendus, du plus récent au plus ancien ;
 *   3. les compteurs vivants — temps écoulé, appels, dépense.
 *
 * Le fil est plafonné : au-delà d'une trentaine d'entrées, il déroulerait
 * sans fin et deviendrait illisible. Rien n'est perdu, tout revient dans le
 * rapport final.
 * ============================================================================
 */

import { useEffect, useState } from 'react';

import type { StepEvent } from './ScanTimeline.tsx';
import { stepTranslations, type StepName } from '../lib/step_translations.ts';
import { useI18n } from '../../i18n/context.tsx';
import { Icon, type IconName } from './Icon.tsx';

/** Entrées gardées à l'écran. Au-delà, l'ancien sort par le bas. */
const FEED_LIMIT = 30;

/**
 * Un bouclier par zone, décliné : intact, interrogé, alerté.
 *
 * Trois variantes du même objet plutôt que trois symboles sans rapport — l'œil
 * lit la série d'un coup, et la couleur (posée par la classe, pas par l'icône)
 * reste le seul signal fort.
 */
const ZONE_STYLE: Record<string, { icon: IconName; className: string }> = {
  sain: { icon: 'shield-check', className: 'vp-zone-safe' },
  a_verifier: { icon: 'shield-question', className: 'vp-zone-grey' },
  alerte: { icon: 'shield-alert', className: 'vp-zone-alert' },
};

export interface LiveActivityProps {
  events: StepEvent[];
  currentStep: StepName | null;
  /** false quand le scan est terminé : les compteurs se figent. */
  running: boolean;
  /** Nombre d'adresses annoncé par le devis, pour situer l'avancement. */
  expectedRoutes?: number | null;
}

interface Counters {
  routesDone: number;
  routesTotal: number;
  alerts: number;
  greyZone: number;
  safe: number;
  freeVerdicts: number;
  /** Verdicts resservis d'un scan précédent sur exactement le même code. */
  cachedVerdicts: number;
  calls: number;
  costUsd: number | null;
  tokens: number;
}

/**
 * Réduit le flux à des compteurs.
 *
 * Recalculé depuis zéro à chaque rendu plutôt qu'incrémenté : le flux SSE
 * rejoue son historique à chaque reconnexion, et un compteur incrémental
 * doublerait tout ce qui a été rejoué.
 */
export function computeCounters(events: StepEvent[]): Counters {
  const counters: Counters = {
    routesDone: 0,
    routesTotal: 0,
    alerts: 0,
    greyZone: 0,
    safe: 0,
    freeVerdicts: 0,
    cachedVerdicts: 0,
    calls: 0,
    costUsd: null,
    tokens: 0,
  };

  for (const event of events) {
    if (event.progress) {
      counters.routesDone = Math.max(counters.routesDone, event.progress.done);
      counters.routesTotal = Math.max(counters.routesTotal, event.progress.total);
    }
    if (event.verdict) {
      if (event.verdict.zone === 'alerte') counters.alerts += 1;
      else if (event.verdict.zone === 'a_verifier') counters.greyZone += 1;
      else counters.safe += 1;
      // Comptés séparément : « tranché sans IA » dit ce que les règles
      // couvrent, « déjà connu » dit ce qui n'a pas bougé depuis le dernier
      // scan. Un total unique ferait passer le second pour le premier.
      if (event.verdict.cached) counters.cachedVerdicts += 1;
      else if (event.verdict.free) counters.freeVerdicts += 1;
    }
    if (event.usage) {
      // Cumulé côté serveur : on garde le dernier, on n'additionne pas.
      counters.calls = Math.max(counters.calls, event.usage.calls);
      counters.tokens = Math.max(
        counters.tokens,
        event.usage.input_tokens + event.usage.output_tokens + event.usage.thinking_tokens
      );
      if (event.usage.cost_usd !== null) {
        counters.costUsd = Math.max(counters.costUsd ?? 0, event.usage.cost_usd);
      }
    }
  }

  return counters;
}

/** Dernier événement portant une adresse en cours d'examen, sans verdict. */
export function currentRoute(events: StepEvent[]): StepEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.route && !event.verdict && event.status === 'running') return event;
    if (event.verdict) return null;
  }
  return null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`;
}

/** Chronomètre : la seule chose qui bouge quand un appel dure vingt secondes. */
function useElapsed(running: boolean): number {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  return (running ? now : Math.max(now, startedAt)) - startedAt;
}

export function LiveActivity({ events, currentStep, running, expectedRoutes }: LiveActivityProps) {
  const { locale, t } = useI18n();
  const zoneLabel: Record<string, string> = {
    sain: t.live.zoneSafe,
    a_verifier: t.live.zoneGrey,
    alerte: t.live.zoneAlert,
  };
  const elapsed = useElapsed(running);
  const counters = computeCounters(events);
  const inFlight = currentRoute(events);

  const total = counters.routesTotal || expectedRoutes || 0;
  const percent = total > 0 ? Math.min(Math.round((counters.routesDone / total) * 100), 100) : 0;

  // Le fil ne retient que ce qui a du sens pour un humain : un verdict rendu,
  // ou un échec. Les événements de compteur n'y figurent pas — ils sont déjà
  // dans les chiffres au-dessus.
  const feed = events
    .filter((event) => event.verdict || (event.status === 'failed' && event.route))
    .slice(-FEED_LIMIT)
    .reverse();

  const stepLabel = currentStep ? stepTranslations(locale)[currentStep]?.label : null;

  return (
    <section className="vp-live" aria-label={t.live.title}>
      <header className="vp-live-head">
        <div>
          {/* Meme raison que dans le panneau de consommation : section soeur,
              donc niveau 2. */}
          <h2>
            {running ? (
              <>
                <span className="vp-pulse" aria-hidden="true" />
                {stepLabel ?? t.live.title}
              </>
            ) : (
              t.live.finished
            )}
          </h2>
          {inFlight?.route && running && (
            <p className="vp-live-current" aria-live="polite">
              {t.live.examining} <code>{inFlight.route.http_method} {inFlight.route.route}</code>
            </p>
          )}
        </div>
        <span className="vp-live-clock">
          {formatElapsed(elapsed)}
        </span>
      </header>

      {total > 0 && (
        <div className="vp-live-progress">
          <div className="vp-live-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="vp-live-progress-label">
            {t.live.progress(counters.routesDone, total)}
          </span>
        </div>
      )}

      <ul className="vp-live-counters">
        <li className="vp-zone-alert">
          <strong>{counters.alerts}</strong>
          <span>{t.live.countersAlerts}</span>
        </li>
        <li className="vp-zone-grey">
          <strong>{counters.greyZone}</strong>
          <span>{t.live.countersGrey}</span>
        </li>
        <li className="vp-zone-safe">
          <strong>{counters.safe}</strong>
          <span>{t.live.countersSafe}</span>
        </li>
        <li>
          <strong>{counters.calls}</strong>
          <span>
            {t.live.countersCalls}
            {counters.freeVerdicts > 0 && t.live.countersFree(counters.freeVerdicts)}
            {counters.cachedVerdicts > 0 && t.live.countersCached(counters.cachedVerdicts)}
          </span>
        </li>
        <li>
          {/* Un coût non communiqué reste « — » : jamais 0 $ par défaut. */}
          <strong>
            {counters.costUsd === null
              ? '—'
              : counters.costUsd === 0
                ? '0 $'
                : `${counters.costUsd.toFixed(4)} $`}
          </strong>
          <span>
            {t.live.countersSpent}
            {counters.costUsd === null ? t.live.countersNotReported : ''}
          </span>
        </li>
      </ul>

      {feed.length > 0 && (
        <ol className="vp-live-feed" aria-label={t.live.feedLabel} aria-live="polite">
          {feed.map((event) => {
            const zone = event.verdict ? ZONE_STYLE[event.verdict.zone]! : null;
            return (
              <li key={event.seq} className={zone?.className ?? 'vp-zone-failed'}>
                <span className="vp-live-icon">
                  <Icon name={zone?.icon ?? 'warning'} size={18} />
                </span>
                <div>
                  <code className="vp-live-route">
                    {event.route?.http_method} {event.route?.route}
                  </code>
                  <span className="vp-live-zone">
                    {event.verdict ? zoneLabel[event.verdict.zone] : t.live.zoneFailed}
                  </span>
                  <p>{event.plain_language}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {running && feed.length === 0 && (
        <p className="vp-live-waiting">
          {t.live.waiting}
        </p>
      )}
    </section>
  );
}
