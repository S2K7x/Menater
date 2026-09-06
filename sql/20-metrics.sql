-- =====================================================================
-- 20-metrics — l'instantane de mesures lu par 05-Audit-Log
-- =====================================================================
-- `soc_metrics_7d()` etait APPELEE par le workflow d'audit et n'existait pas.
-- Sur une base neuve, l'appel echouait : le workflow retombait alors sur son
-- chemin « mesures indisponibles », ce qui est le bon comportement — mais on
-- n'avait jamais de mesures du tout.
--
-- ---------------------------------------------------------------------
-- LES DEUX TAUX NE SE CONFONDENT JAMAIS
--
--   `ai_false_positive_verdict_rate` — part des alertes classees faux
--     positif. Mesure de DISTRIBUTION. Elle ne dit rien de la justesse : un
--     modele qui classerait tout en faux positif afficherait 100 %.
--
--   `human_disagreement_rate` — part des decisions soumises a un humain
--     qu'il a REJETEES. Seul proxy de faux positif observable sans verite
--     terrain. C'est celui-ci, et lui seul, qui conditionne la sortie du
--     shadow mode.
--
-- Les nommer differemment dans le SQL autant que dans le code evite qu'on
-- lise l'un en croyant lire l'autre.
--
-- ---------------------------------------------------------------------
-- UN TAUX SANS DENOMINATEUR VAUT `NULL`, JAMAIS ZERO
--
-- `NULLIF(count(...), 0)` partout. « Aucune decision soumise a un humain » et
-- « aucun desaccord humain » menent a des decisions OPPOSEES sur la bascule,
-- et zero les rendrait indiscernables.
-- =====================================================================

CREATE OR REPLACE FUNCTION soc_metrics_7d()
RETURNS TABLE (
  alerts_total                    integer,
  alerts_shadow                   integer,
  alerts_live                     integer,
  actions_executed                integer,
  avg_tokens_per_alert            numeric,
  tokens_total                    bigint,
  avg_latency_ms                  numeric,
  p95_latency_ms                  numeric,
  avg_confidence                  numeric,
  ai_false_positive_verdict_rate  numeric,
  human_disagreement_rate         numeric,
  fallback_rate                   numeric,
  approval_timeout_rate           numeric,
  shadow_decisions                integer,
  threshold                       integer,
  threshold_reached               boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH w AS (
    SELECT * FROM soc_audit_log WHERE event_time > now() - interval '7 days'
  ),
  -- Les decisions REELLEMENT soumises a un humain qui a repondu. Un timeout
  -- n'est pas un desaccord : c'est une absence de reponse, et la compter
  -- comme un accord gonflerait artificiellement la confiance.
  reviewed AS (
    SELECT * FROM w WHERE routing_outcome IN ('approved', 'rejected')
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE shadow_mode)::integer,
    count(*) FILTER (WHERE NOT shadow_mode)::integer,
    count(*) FILTER (WHERE executed)::integer,
    round(avg(tokens_used), 1),
    coalesce(sum(tokens_used), 0)::bigint,
    round(avg(latency_ms), 0),
    round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 0),
    round(avg(confidence), 3),

    -- Distribution, pas justesse.
    round(100.0 * count(*) FILTER (WHERE verdict = 'false_positive')
          / NULLIF(count(*) FILTER (WHERE verdict IS NOT NULL), 0), 1),

    -- LE taux qui conditionne la sortie du shadow mode.
    round(100.0 * (SELECT count(*) FROM reviewed WHERE human_override)
          / NULLIF((SELECT count(*) FROM reviewed), 0), 1),

    round(100.0 * count(*) FILTER (WHERE is_fallback) / NULLIF(count(*), 0), 1),

    round(100.0 * count(*) FILTER (WHERE routing_outcome = 'timeout_escalated')
          / NULLIF(count(*) FILTER (WHERE routing_outcome IS NOT NULL), 0), 1),

    -- Le baseline compte TOUTES les decisions en shadow mode, sans fenetre :
    -- la fenetre de sept jours mesure l'activite recente, le baseline mesure
    -- ce qu'on a observe depuis le debut. Les confondre remettrait le
    -- compteur a zero chaque semaine.
    (SELECT count(*)::integer FROM soc_audit_log WHERE shadow_mode),
    50,
    (SELECT count(*) FROM soc_audit_log WHERE shadow_mode) >= 50
  FROM w;
$$;

REVOKE ALL ON FUNCTION soc_metrics_7d() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soc_metrics_7d() TO n8n_soc;
