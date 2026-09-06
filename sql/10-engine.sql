-- =====================================================================
-- 10-engine — journal d'exécution du moteur de workflow
-- =====================================================================
-- Ce schema remplace ce que la console reconstituait jusqu'ici depuis l'API
-- n8n, une requete par execution. Les donnees deviennent de premiere main :
-- l'onglet Suivi lit des lignes au lieu de recoller des executions par
-- alert_id, et le cout d'un rafraichissement passe d'un fan-out de 120
-- requetes HTTP a une requete SQL.
--
-- ---------------------------------------------------------------------
-- CE QUI REND CE SCHEMA SUR, ET PAS SEULEMENT PRATIQUE
--
--  1. `soc_run_step` PORTE UNE CONTRAINTE D'UNICITE sur (run, node, attempt).
--     C'est elle qui rend « au plus une fois » verifiable par la base et non
--     seulement promis par le code : deux processus qui tenteraient la meme
--     etape se heurtent a la contrainte au lieu de doubler l'appel.
--
--  2. UNE ATTENTE NE SE TRANCHE QU'UNE FOIS. `soc_run_wait.resumed_at` est
--     pose par un UPDATE conditionnel ; un double clic, un lien rouvert ou un
--     rejeu de requete ne produit qu'une seule prise d'effet.
--
--  3. LE VERROU EST DANS LA BASE. `owner` + `claimed_at` : une seconde console
--     qui demarrerait ne reprend pas des executions deja reprises ailleurs.
--     L'hypothese « un seul processus » devient fausse bruyamment.
--
-- ---------------------------------------------------------------------
-- CE QUE CE SCHEMA NE TOUCHE PAS
--
-- `soc_audit_log` et sa chaine de hachage restent inchanges. L'audit est la
-- preuve de ce qui s'est passe ; le journal d'execution est l'outil qui l'a
-- fait. Les confondre reviendrait a laisser le moteur ecrire sa propre preuve.
-- =====================================================================

CREATE TABLE IF NOT EXISTS soc_workflow (
  id            text         PRIMARY KEY,
  name          text         NOT NULL,
  version       integer      NOT NULL,
  -- Le graphe complet. Stocke tel quel : c'est lui que l'onglet Workflow lit
  -- et republie, et une execution garde SA version meme apres republication.
  definition    jsonb        NOT NULL,
  published_at  timestamptz  NOT NULL DEFAULT now(),
  published_by  text,

  CONSTRAINT soc_workflow_version_positive CHECK (version >= 1)
);

-- Historique des versions : republier n'ecrase pas, il empile. Une execution
-- ancienne doit pouvoir etre relue avec le graphe qui l'a produite.
CREATE TABLE IF NOT EXISTS soc_workflow_version (
  workflow_id   text         NOT NULL,
  version       integer      NOT NULL,
  definition    jsonb        NOT NULL,
  published_at  timestamptz  NOT NULL DEFAULT now(),
  published_by  text,

  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS soc_run (
  id                text         PRIMARY KEY,
  workflow_id       text         NOT NULL,
  workflow_version  integer      NOT NULL,
  status            text         NOT NULL,
  -- Correlation metier. C'est par lui que la console recolle les cas ; il peut
  -- rester NULL, et une execution sans alert_id est alors listee comme telle
  -- plutot que masquee.
  alert_id          text,
  input             jsonb        NOT NULL,
  started_at        timestamptz  NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  error             text,

  -- Verrou d'execution. Voir le point 3 de l'en-tete.
  owner             text,
  claimed_at        timestamptz,

  CONSTRAINT soc_run_status_enum
    CHECK (status IN ('running','waiting','done','failed','cancelled')),
  -- Une execution terminee a une date de fin, une execution en cours n'en a
  -- pas. Sans cette contrainte, une ligne « terminee » sans date passe
  -- inapercue et fausse toutes les mesures de duree.
  CONSTRAINT soc_run_ended_consistency
    CHECK ((status IN ('done','failed','cancelled')) = (ended_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS soc_run_alert_idx      ON soc_run (alert_id);
CREATE INDEX IF NOT EXISTS soc_run_started_idx    ON soc_run (started_at DESC);
-- Index partiel : la reprise au demarrage ne cherche QUE les inachevees, et
-- elles sont une poignee parmi des dizaines de milliers de lignes.
CREATE INDEX IF NOT EXISTS soc_run_unfinished_idx ON soc_run (status)
  WHERE status IN ('running','waiting');

CREATE TABLE IF NOT EXISTS soc_run_step (
  run_id      text         NOT NULL REFERENCES soc_run(id) ON DELETE CASCADE,
  -- IDENTIFIANT du noeud, jamais son etiquette. Renommer un noeud dans
  -- l'editeur ne doit pas rendre le journal illisible — c'est exactement le
  -- couplage par nom qui rendait la console aveugle sous n8n.
  node_id     text         NOT NULL,
  attempt     integer      NOT NULL,
  status      text         NOT NULL,
  output      jsonb,
  -- Port emprunte en sortie : c'est lui qui explique pourquoi la suite a pris
  -- telle branche, six mois plus tard, quand personne ne s'en souvient.
  port        text,
  error       text,
  started_at  timestamptz  NOT NULL DEFAULT now(),
  ended_at    timestamptz,

  PRIMARY KEY (run_id, node_id, attempt),

  CONSTRAINT soc_run_step_status_enum
    CHECK (status IN ('pending','running','ok','failed','skipped','indeterminate'))
);

CREATE INDEX IF NOT EXISTS soc_run_step_run_idx ON soc_run_step (run_id, started_at);
-- Les etapes indeterminees sont ce qu'un humain doit trancher : elles se
-- cherchent seules, et elles sont rares.
CREATE INDEX IF NOT EXISTS soc_run_step_indeterminate_idx ON soc_run_step (run_id)
  WHERE status = 'indeterminate';

CREATE TABLE IF NOT EXISTS soc_run_wait (
  token       text         PRIMARY KEY,
  run_id      text         NOT NULL REFERENCES soc_run(id) ON DELETE CASCADE,
  node_id     text         NOT NULL,
  -- Au-dela, l'attente expire. L'EXPIRATION N'EST PAS UN ACCORD : elle
  -- emprunte un port `timeout` distinct, que le workflow doit traiter
  -- explicitement — vers une escalade, jamais vers l'action.
  deadline    timestamptz  NOT NULL,
  resumed_at  timestamptz,
  payload     jsonb,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  -- Une attente tranchee porte une charge utile (la decision) OU la marque
  -- d'expiration. Une attente non tranchee n'a ni l'un ni l'autre.
  CONSTRAINT soc_run_wait_payload_requires_resume
    CHECK (payload IS NULL OR resumed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS soc_run_wait_run_idx ON soc_run_wait (run_id);
-- Le balayage des echeances ne regarde que les attentes ouvertes.
CREATE INDEX IF NOT EXISTS soc_run_wait_pending_idx ON soc_run_wait (deadline)
  WHERE resumed_at IS NULL;

-- ---------------------------------------------------------------------
-- Variables du pipeline, editables depuis l'onglet Reglages.
--
-- Elles remplacent les variables d'environnement du conteneur n8n : le seul
-- moyen de changer un seuil etait d'editer docker-compose et de redemarrer.
-- Une valeur versionnee et datee dit AUSSI qui l'a changee et quand — ce que
-- `docker-compose` ne dit jamais.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soc_variable (
  key         text         PRIMARY KEY,
  value       jsonb        NOT NULL,
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS soc_variable_history (
  id          bigserial    PRIMARY KEY,
  key         text         NOT NULL,
  old_value   jsonb,
  new_value   jsonb        NOT NULL,
  changed_at  timestamptz  NOT NULL DEFAULT now(),
  changed_by  text
);

-- ---------------------------------------------------------------------
-- Droits du role applicatif.
--
-- CE BLOC MANQUAIT. Les quatre autres fichiers du schema accordent leurs
-- droits a `n8n_soc` ; celui-ci ne le faisait pas, alors qu'il porte les
-- tables du moteur INTEGRE — c'est-a-dire celles que la console ecrit
-- elle-meme, sans passer par n8n. Consequence exacte : chaque alerte ingeree
-- repondait `permission denied for table soc_run`, dans le seul bloc
-- `console_engine` de la reponse du webhook. L'interface, elle, n'en montrait
-- rien : une panne totale du moteur s'affichait en vert.
--
-- Pas de DELETE ni de TRUNCATE : un journal d'execution se conserve, et le
-- role applicatif n'a aucune raison de pouvoir effacer sa propre trace.
-- ---------------------------------------------------------------------
REVOKE ALL ON soc_run, soc_run_step, soc_run_wait,
              soc_variable, soc_variable_history,
              soc_workflow, soc_workflow_version FROM PUBLIC;

-- Executions : creees, puis avancees d'une etape a l'autre.
GRANT SELECT, INSERT, UPDATE ON soc_run, soc_run_step, soc_run_wait TO n8n_soc;

-- Variables : `ON CONFLICT (key) DO UPDATE` demande INSERT ET UPDATE.
GRANT SELECT, INSERT, UPDATE ON soc_variable          TO n8n_soc;
-- L'historique ne se reecrit pas : il s'ajoute.
GRANT SELECT, INSERT         ON soc_variable_history  TO n8n_soc;
GRANT USAGE, SELECT ON SEQUENCE soc_variable_history_id_seq TO n8n_soc;

-- Definitions de workflow : le moteur les LIT, il ne les redefinit pas
-- depuis une requete applicative.
GRANT SELECT ON soc_workflow, soc_workflow_version TO n8n_soc;

REVOKE DELETE, TRUNCATE ON soc_run, soc_run_step, soc_run_wait,
                           soc_variable, soc_variable_history FROM n8n_soc;
