-- ---------------------------------------------------------------------
-- Tuning rules — how a team teaches its own SOC what is normal here.
--
-- WHY THE HISTORY TABLE IS NOT OPTIONAL. A tuning rule decides that certain
-- alerts stop reaching a human. "Who silenced this, when, and why" has to be
-- answerable months later, from the database alone, by someone who no longer
-- has the console open. That is the same reason `soc_audit_log` is
-- append-only, and it applies here with more force: an audit row records
-- what the pipeline decided, this records what a person decided it should
-- stop deciding.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS soc_tuning_rule (
  id           uuid         PRIMARY KEY,
  name         text         NOT NULL,
  enabled      boolean      NOT NULL DEFAULT false,
  -- Lower runs first. Ties break on id in the engine, so the order in which
  -- rules are applied is total and never depends on insertion order.
  priority     integer      NOT NULL DEFAULT 100,
  -- The conditions, as written. `jsonb` rather than a child table: they are
  -- read as a whole, on every alert, and never queried field by field.
  conditions   jsonb        NOT NULL,
  action       text         NOT NULL,
  severity     text,
  -- Governance. NOT NULL on purpose: an exception nobody owns and nobody can
  -- justify is security debt, and the schema is where that stops being
  -- a matter of discipline.
  owner        text         NOT NULL,
  reason       text         NOT NULL,
  expires_at   timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  -- Measurement. Without these, nobody can tell a rule that protects the
  -- queue from one that has quietly matched nothing for a year.
  match_count  bigint       NOT NULL DEFAULT 0,
  last_matched_at timestamptz,

  CONSTRAINT soc_tuning_action_known
    CHECK (action IN ('allow', 'suppress', 'severity', 'escalate')),
  CONSTRAINT soc_tuning_severity_known
    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  -- A suppression is temporary BY DEFINITION. One with no end date is an
  -- `allow` that has not admitted what it is, and the database says so too.
  CONSTRAINT soc_tuning_suppress_expires
    CHECK (action <> 'suppress' OR expires_at IS NOT NULL)
);

-- The engine loads enabled rules on every alert: the index is what keeps that
-- from becoming a sequential scan once a team has a few hundred.
CREATE INDEX IF NOT EXISTS soc_tuning_rule_active
  ON soc_tuning_rule (priority, id) WHERE enabled;

-- ---------------------------------------------------------------------
-- History. Append-only, like the audit log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soc_tuning_rule_history (
  id          bigserial    PRIMARY KEY,
  rule_id     uuid         NOT NULL,
  -- `created`, `updated`, `deleted`. A deletion keeps the last known state in
  -- `snapshot`, so removing a rule does not remove the record that it existed.
  change      text         NOT NULL,
  snapshot    jsonb        NOT NULL,
  changed_at  timestamptz  NOT NULL DEFAULT now(),
  changed_by  text,

  CONSTRAINT soc_tuning_change_known CHECK (change IN ('created', 'updated', 'deleted'))
);

CREATE INDEX IF NOT EXISTS soc_tuning_history_rule
  ON soc_tuning_rule_history (rule_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- Rights of the application role.
--
-- No DELETE on the history: a rule can be removed, the record that it once
-- existed cannot. The rule table itself DOES allow DELETE — a tuning rule is
-- meant to be removable, and the history is what makes that safe.
-- ---------------------------------------------------------------------
REVOKE ALL ON soc_tuning_rule, soc_tuning_rule_history FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON soc_tuning_rule           TO n8n_soc;
GRANT SELECT, INSERT                 ON soc_tuning_rule_history   TO n8n_soc;
GRANT USAGE, SELECT ON SEQUENCE soc_tuning_rule_history_id_seq    TO n8n_soc;

REVOKE UPDATE, DELETE, TRUNCATE ON soc_tuning_rule_history FROM n8n_soc;
REVOKE TRUNCATE ON soc_tuning_rule FROM n8n_soc;
