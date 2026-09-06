-- =====================================================================
-- 06-Error-Handler — journal d'erreurs, separe de soc_audit_log
-- =====================================================================
-- Deliberement distinct de l'audit : l'audit est append-only et scelle par
-- chainage de hash (conformite) ; le journal d'erreurs est operationnel, purgeable,
-- et ne doit jamais partager le sort de la table d'audit.
-- =====================================================================

CREATE TABLE IF NOT EXISTS soc_error_log (
  id               bigserial   PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  workflow_name    text        NOT NULL,
  workflow_id      text,
  node_name        text,
  stage            text,
  error_code       text,
  error_message    text        NOT NULL,
  severity         text        NOT NULL,
  alert_id         text,
  execution_id     text,
  execution_url    text,
  requires_replay  boolean     NOT NULL DEFAULT false,
  source_kind      text        NOT NULL,   -- 'explicit' (branche d'erreur) | 'error_trigger' (crash n8n)
  original_payload jsonb,
  details          jsonb,
  CONSTRAINT soc_error_severity_enum CHECK (severity IN ('low','medium','high')),
  CONSTRAINT soc_error_source_enum   CHECK (source_kind IN ('explicit','error_trigger'))
);

CREATE INDEX IF NOT EXISTS soc_error_window_idx   ON soc_error_log (workflow_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS soc_error_severity_idx ON soc_error_log (severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS soc_error_alert_idx    ON soc_error_log (alert_id);
CREATE INDEX IF NOT EXISTS soc_error_replay_idx   ON soc_error_log (requires_replay) WHERE requires_replay;

-- Alertes "panne systemique" deja emises : sert de fenetre de suppression pour ne pas
-- reposter la meme alerte a chaque erreur d'une rafale.
CREATE TABLE IF NOT EXISTS soc_error_systemic_alerts (
  id             bigserial   PRIMARY KEY,
  workflow_name  text        NOT NULL,
  emitted_at     timestamptz NOT NULL DEFAULT now(),
  error_count    integer     NOT NULL,
  window_minutes integer     NOT NULL,
  threshold      integer     NOT NULL
);
CREATE INDEX IF NOT EXISTS soc_error_systemic_idx ON soc_error_systemic_alerts (workflow_name, emitted_at DESC);

-- Tentatives de notification, y compris les abandons. C'est la trace du
-- "max 3 tentatives puis abandon logge" : sans elle, un Slack down est invisible.
CREATE TABLE IF NOT EXISTS soc_error_notifications (
  id            bigserial   PRIMARY KEY,
  error_id      bigint      REFERENCES soc_error_log(id),
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  channel       text,
  route         text        NOT NULL,   -- low | medium | high | systemic
  status        text        NOT NULL,   -- sent | skipped | failed_abandoned
  detail        text,
  CONSTRAINT soc_error_notif_status_enum CHECK (status IN ('sent','skipped','failed_abandoned'))
);
CREATE INDEX IF NOT EXISTS soc_error_notif_idx ON soc_error_notifications (attempted_at DESC);

-- ---------------------------------------------------------------------
-- Vues operationnelles
-- ---------------------------------------------------------------------

-- Sante par workflow sur l'heure glissante : c'est ce que lit la detection systemique.
CREATE OR REPLACE VIEW soc_error_rate_last_hour AS
SELECT workflow_name,
       count(*)                                            AS errors,
       count(DISTINCT error_code)                          AS distinct_codes,
       count(*) FILTER (WHERE severity = 'high')           AS high,
       count(*) FILTER (WHERE severity = 'medium')         AS medium,
       count(*) FILTER (WHERE severity = 'low')            AS low,
       min(occurred_at)                                    AS first_error,
       max(occurred_at)                                    AS last_error,
       array_agg(DISTINCT error_code)                      AS codes
FROM soc_error_log
WHERE occurred_at >= now() - interval '1 hour'
GROUP BY workflow_name
ORDER BY errors DESC;

-- File de rejeu : ce qui a ete perdu et doit etre repasse (typiquement AUDIT_WRITE_FAILED).
CREATE OR REPLACE VIEW soc_error_replay_queue AS
SELECT id, occurred_at, workflow_name, error_code, alert_id, error_message, details
FROM soc_error_log
WHERE requires_replay
ORDER BY occurred_at DESC;

-- Notifications abandonnees : si cette vue n'est pas vide, des incidents sont muets.
CREATE OR REPLACE VIEW soc_error_silent_failures AS
SELECT n.attempted_at, n.route, n.channel, n.detail,
       e.workflow_name, e.severity, e.error_code, e.error_message
FROM soc_error_notifications n
LEFT JOIN soc_error_log e ON e.id = n.error_id
WHERE n.status = 'failed_abandoned'
ORDER BY n.attempted_at DESC;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
REVOKE ALL ON soc_error_log, soc_error_systemic_alerts, soc_error_notifications FROM PUBLIC;
GRANT SELECT, INSERT ON soc_error_log, soc_error_systemic_alerts, soc_error_notifications TO n8n_soc;
GRANT USAGE, SELECT ON SEQUENCE soc_error_log_id_seq, soc_error_systemic_alerts_id_seq,
                                soc_error_notifications_id_seq TO n8n_soc;
GRANT SELECT ON soc_error_rate_last_hour, soc_error_replay_queue, soc_error_silent_failures TO n8n_soc;
-- La purge est un travail du proprietaire du schema, pas du compte applicatif :
--   DELETE FROM soc_error_log WHERE occurred_at < now() - interval '90 days';
