-- =====================================================================
-- 05-Audit-Log — table d'audit append-only, tamper-evident
-- =====================================================================
-- Le chainage de hash est calcule PAR LA BASE (trigger BEFORE INSERT), pas par
-- n8n : ni le workflow, ni quiconque disposant du compte n8n ne peut forger un
-- maillon coherent sans droits d'ecriture sur le schema.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS soc_audit_log (
  id                            bigserial    PRIMARY KEY,
  alert_id                      text         NOT NULL,
  event_time                    timestamptz  NOT NULL DEFAULT now(),
  source_workflow               text         NOT NULL,

  -- decision IA
  verdict                       text,
  confidence                    numeric(4,3),
  recommended_action            text,
  decision_source               text,
  is_fallback                   boolean      NOT NULL DEFAULT false,

  -- execution
  executed                      boolean      NOT NULL DEFAULT false,
  shadow_mode                   boolean      NOT NULL,
  routing_outcome               text,
  action_taken                  text,

  -- garde-fou humain
  human_approver                text,
  human_approver_id             text,
  human_override                boolean      NOT NULL DEFAULT false,
  human_reasoning               text,

  -- observabilite
  tokens_used                   integer,
  latency_ms                    integer,
  enrichment_sources_available  text[]       NOT NULL DEFAULT '{}',

  -- contexte alerte
  rule_name                     text,
  severity                      text,
  source_ip                     text,
  dest_ip                       text,
  execution_id                  text,
  payload                       jsonb        NOT NULL,

  -- chainage d'integrite
  prev_hash                     char(64)     NOT NULL,
  integrity_hash                char(64)     NOT NULL,

  CONSTRAINT soc_audit_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT soc_audit_verdict_enum     CHECK (verdict IS NULL OR verdict IN ('false_positive','true_positive','needs_human')),
  CONSTRAINT soc_audit_action_enum      CHECK (recommended_action IS NULL OR recommended_action IN ('auto_close','escalate','isolate_host_temporary','ticket')),
  -- Une action ne peut pas etre marquee executee en shadow mode. Invariant structurel.
  CONSTRAINT soc_audit_shadow_never_executes CHECK (NOT (shadow_mode AND executed))
);

CREATE INDEX IF NOT EXISTS soc_audit_alert_id_idx    ON soc_audit_log (alert_id);
CREATE INDEX IF NOT EXISTS soc_audit_event_time_idx  ON soc_audit_log (event_time DESC);
CREATE INDEX IF NOT EXISTS soc_audit_verdict_idx     ON soc_audit_log (verdict, shadow_mode);

-- ---------------------------------------------------------------------
-- Representation canonique d'une ligne : deterministe, sans NULL ambigu.
-- C'est ce que le hash couvre. Toute modification d'un de ces champs casse
-- la chaine a partir de cette ligne.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soc_audit_canonical(r soc_audit_log)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT
    coalesce(r.alert_id, '')                                                      || '|' ||
    to_char(r.event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')     || '|' ||
    coalesce(r.source_workflow, '')                                               || '|' ||
    coalesce(r.verdict, '')                                                       || '|' ||
    coalesce(r.confidence::text, '')                                              || '|' ||
    coalesce(r.recommended_action, '')                                            || '|' ||
    coalesce(r.decision_source, '')                                               || '|' ||
    r.is_fallback::text                                                           || '|' ||
    r.executed::text                                                              || '|' ||
    r.shadow_mode::text                                                           || '|' ||
    coalesce(r.routing_outcome, '')                                               || '|' ||
    coalesce(r.action_taken, '')                                                  || '|' ||
    coalesce(r.human_approver, '')                                                || '|' ||
    coalesce(r.human_approver_id, '')                                             || '|' ||
    r.human_override::text                                                        || '|' ||
    coalesce(r.human_reasoning, '')                                               || '|' ||
    coalesce(r.tokens_used::text, '')                                             || '|' ||
    coalesce(r.latency_ms::text, '')                                              || '|' ||
    coalesce(array_to_string(r.enrichment_sources_available, ','), '')            || '|' ||
    coalesce(r.rule_name, '')                                                     || '|' ||
    coalesce(r.severity, '')                                                      || '|' ||
    coalesce(r.source_ip, '')                                                     || '|' ||
    coalesce(r.dest_ip, '')                                                       || '|' ||
    coalesce(r.execution_id, '')                                                  || '|' ||
    encode(digest(coalesce(r.payload::text, ''), 'sha256'), 'hex')
$$;

-- ---------------------------------------------------------------------
-- Sealing: integrity_hash = SHA-256(canonical form || previous row's hash)
--
-- THE ADVISORY LOCK WAS NOT ENOUGH, AND THE REASON IS SUBTLE.
--
-- It serialises the SEALING, so no two transactions read the same predecessor.
-- But `id` is a bigserial, and its DEFAULT is evaluated BEFORE this trigger
-- runs — that is, before the lock is taken. So under concurrency:
--
--     txn A takes id 433, then waits for the lock
--     txn B takes id 434, gets the lock first, seals against 432
--     txn A gets the lock, seals against 434 — while carrying id 433
--
-- The chain is a perfectly intact linked list; it is simply not in id order
-- any more. And `soc_audit_verify_chain()` walks by id, so it reported
-- BROKEN_LINK — "row deleted or reordered" — on rows nobody had touched.
--
-- Measured under a stress pass: 22 of 3195 rows, about 0.7%, every one of them
-- a pair that had sealed in the opposite order to their ids.
--
-- THAT IS THE WORST POSSIBLE FALSE ALARM for this table. It is the product's
-- only tamper-evidence; a verifier that cries wolf on healthy rows is one an
-- auditor stops believing, and it would hide a real deletion in the noise.
--
-- The fix is to allocate the id INSIDE the lock, so id order and seal order
-- cannot diverge. The value the DEFAULT already burned is simply skipped —
-- gaps in a sequence are normal and cost nothing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soc_audit_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p char(64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('soc_audit_log'));
  -- Inside the lock, so the id order IS the seal order. Set before the hash is
  -- computed, because the canonical form is hashed after this point.
  NEW.id := nextval('soc_audit_log_id_seq');
  SELECT integrity_hash INTO p FROM soc_audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(p, repeat('0', 64));
  NEW.integrity_hash := encode(digest(soc_audit_canonical(NEW) || NEW.prev_hash, 'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_soc_audit_seal ON soc_audit_log;
CREATE TRIGGER trg_soc_audit_seal
  BEFORE INSERT ON soc_audit_log
  FOR EACH ROW EXECUTE FUNCTION soc_audit_seal();

-- ---------------------------------------------------------------------
-- Append-only, defense en profondeur : meme un role a qui l'on aurait
-- accorde UPDATE/DELETE par erreur se heurte a ces triggers.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soc_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'soc_audit_log est append-only : % interdit', TG_OP USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_soc_audit_no_update ON soc_audit_log;
CREATE TRIGGER trg_soc_audit_no_update
  BEFORE UPDATE OR DELETE ON soc_audit_log
  FOR EACH ROW EXECUTE FUNCTION soc_audit_immutable();

DROP TRIGGER IF EXISTS trg_soc_audit_no_truncate ON soc_audit_log;
CREATE TRIGGER trg_soc_audit_no_truncate
  BEFORE TRUNCATE ON soc_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION soc_audit_immutable();

-- ---------------------------------------------------------------------
-- Verification de la chaine. Rejoue le calcul ligne par ligne.
--   SELECT * FROM soc_audit_verify_chain() WHERE status <> 'ok';
-- Un resultat vide = aucune alteration detectable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soc_audit_verify_chain(p_from bigint DEFAULT 0)
RETURNS TABLE (id bigint, alert_id text, status text, expected_hash char(64), stored_hash char(64))
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r        soc_audit_log%ROWTYPE;
  running  char(64);
  expected char(64);
BEGIN
  SELECT coalesce(max(l.integrity_hash), repeat('0', 64)) INTO running
    FROM soc_audit_log l WHERE l.id = p_from;
  IF p_from = 0 THEN running := repeat('0', 64); END IF;

  FOR r IN SELECT * FROM soc_audit_log l WHERE l.id > p_from ORDER BY l.id LOOP
    expected := encode(digest(soc_audit_canonical(r) || running, 'sha256'), 'hex');
    id := r.id; alert_id := r.alert_id; expected_hash := expected; stored_hash := r.integrity_hash;
    IF r.prev_hash <> running THEN
      status := 'BROKEN_LINK: prev_hash does not match the preceding link (row deleted or reordered)';
    ELSIF expected <> r.integrity_hash THEN
      status := 'TAMPERED: the row content no longer matches its own hash';
    ELSE
      status := 'ok';
    END IF;
    RETURN NEXT;
    running := r.integrity_hash;
  END LOOP;
END $$;

-- =====================================================================
-- Vues d'agregation — consommees PAR UN DASHBOARD EXTERNE (Notion/Airtable),
-- jamais par le chemin critique d'ecriture.
-- =====================================================================

-- Taux de faux positifs et cout. Deux taux distincts, volontairement :
--   * ai_false_positive_verdict_rate = part des alertes que l'IA classe FP.
--     C'est une mesure de distribution, PAS une mesure de justesse.
--   * human_disagreement_rate = part des decisions soumises a un humain que
--     l'humain a rejetees. C'est le vrai proxy de faux positif, et c'est LUI
--     qui conditionne la sortie du shadow mode.
CREATE OR REPLACE VIEW soc_audit_metrics_recent AS
SELECT
  now() - interval '7 days'                                             AS window_start,
  count(*)                                                              AS alerts_total,
  count(*) FILTER (WHERE shadow_mode)                                   AS alerts_shadow,
  count(*) FILTER (WHERE NOT shadow_mode)                               AS alerts_live,
  count(*) FILTER (WHERE executed)                                      AS actions_executed,
  round(avg(tokens_used)::numeric, 1)                                   AS avg_tokens_per_alert,
  sum(tokens_used)                                                      AS tokens_total,
  round(avg(latency_ms)::numeric, 0)                                    AS avg_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)              AS p95_latency_ms,
  round(avg(confidence)::numeric, 3)                                    AS avg_confidence,
  round(100.0 * count(*) FILTER (WHERE verdict = 'false_positive')
        / nullif(count(*) FILTER (WHERE verdict IS NOT NULL), 0), 2)    AS ai_false_positive_verdict_rate,
  round(100.0 * count(*) FILTER (WHERE human_override)
        / nullif(count(*) FILTER (WHERE human_approver IS NOT NULL), 0), 2) AS human_disagreement_rate,
  round(100.0 * count(*) FILTER (WHERE is_fallback)
        / nullif(count(*), 0), 2)                                       AS fallback_rate,
  round(100.0 * count(*) FILTER (WHERE routing_outcome = 'timeout_escalated')
        / nullif(count(*) FILTER (WHERE human_approver IS NOT NULL
                                     OR routing_outcome = 'timeout_escalated'), 0), 2) AS approval_timeout_rate
FROM soc_audit_log
WHERE event_time >= now() - interval '7 days';

-- Baseline de sortie du shadow mode : la regle des 50 alertes du CLAUDE.md.
CREATE OR REPLACE VIEW soc_audit_shadow_baseline AS
SELECT
  count(*)                                                   AS shadow_decisions,
  50                                                         AS threshold,
  count(*) >= 50                                             AS threshold_reached,
  count(*) FILTER (WHERE verdict = 'false_positive')          AS shadow_false_positive,
  count(*) FILTER (WHERE verdict = 'true_positive')           AS shadow_true_positive,
  count(*) FILTER (WHERE verdict = 'needs_human')             AS shadow_needs_human,
  count(*) FILTER (WHERE is_fallback)                         AS shadow_fallbacks,
  round(avg(confidence)::numeric, 3)                          AS shadow_avg_confidence,
  min(event_time)                                             AS first_seen,
  max(event_time)                                             AS last_seen
FROM soc_audit_log
WHERE shadow_mode;

-- Desaccords IA/humain, ligne a ligne : le materiau brut du calcul de FP.
CREATE OR REPLACE VIEW soc_audit_human_overrides AS
SELECT id, event_time, alert_id, verdict, confidence, recommended_action,
       routing_outcome, human_approver, human_reasoning, enrichment_sources_available
FROM soc_audit_log
WHERE human_approver IS NOT NULL
ORDER BY event_time DESC;

-- =====================================================================
-- Permissions — le compte n8n ne peut QU'inserer et lire.
-- Adapter le nom du role si besoin.
-- =====================================================================
-- CREATE ROLE n8n_soc LOGIN PASSWORD '***';
REVOKE ALL ON soc_audit_log FROM PUBLIC;
GRANT SELECT, INSERT                ON soc_audit_log            TO n8n_soc;
REVOKE UPDATE, DELETE, TRUNCATE     ON soc_audit_log          FROM n8n_soc;
GRANT USAGE, SELECT                 ON SEQUENCE soc_audit_log_id_seq TO n8n_soc;
GRANT SELECT ON soc_audit_metrics_recent, soc_audit_shadow_baseline, soc_audit_human_overrides TO n8n_soc;
-- Le scellement et la verification appartiennent au proprietaire du schema,
-- pas au compte applicatif : n8n ne peut ni redefinir le trigger, ni le desactiver.
REVOKE EXECUTE ON FUNCTION soc_audit_seal()      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soc_audit_immutable() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION soc_audit_verify_chain(bigint) TO n8n_soc;
