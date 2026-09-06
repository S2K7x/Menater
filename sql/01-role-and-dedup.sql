-- =====================================================================
-- 01 — role applicatif et table de deduplication
-- =====================================================================
-- CE FICHIER COMBLE DEUX TROUS REVELES PAR LA CONTENEURISATION.
--
-- Jusqu'ici, une installation neuve ne pouvait pas fonctionner :
--
--  1. LE ROLE `n8n_soc` N'ETAIT CREE NULLE PART. `05-audit-log.sql` lui
--     accorde des droits (`GRANT ... TO n8n_soc`) mais personne ne le
--     creait — le fichier echouait donc sur une base vierge.
--
--  2. LA TABLE DE DEDUPLICATION VIVAIT DANS UNE STICKY NOTE n8n. Elle etait
--     documentee dans l'editeur, pas dans le depot. Un schema qu'on ne peut
--     appliquer qu'en recopiant a la main depuis une interface graphique
--     n'est pas un schema : c'est une consigne orale.
--
-- Numerote `01` pour s'appliquer AVANT les autres : Postgres execute les
-- fichiers de `/docker-entrypoint-initdb.d/` dans l'ordre alphabetique.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Role applicatif.
--
-- SEPARE DU PROPRIETAIRE DU SCHEMA, et c'est tout l'interet : `05-audit-log`
-- lui accorde SELECT et INSERT sur la table d'audit, puis lui REVOQUE UPDATE,
-- DELETE et TRUNCATE. L'application ne peut donc pas reecrire sa propre
-- preuve, meme si elle est compromise.
--
-- Le mot de passe est pose par la variable d'environnement du conteneur ;
-- `NOLOGIN` ici serait inutile puisque c'est ce role qui se connecte.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_soc') THEN
    CREATE ROLE n8n_soc LOGIN;
  END IF;
END
$$;

-- Le mot de passe vient d'une variable psql posee par le script
-- d'initialisation (`-v app_password=...`), elle-meme alimentee par une
-- variable d'environnement du conteneur.
--
-- CE QUE CELA EVITE : que le mot de passe soit ecrit dans ce depot, ou dans le
-- `docker-compose.yml`, ou visible par `docker compose config`.
--
-- CE QUE CELA N'EVITE PAS : psql substitue la variable AVANT d'envoyer la
-- requete, donc `ALTER ROLE` la porte en clair cote serveur. Sur une base dont
-- `log_statement` est actif, elle apparaitra dans le journal. C'est acceptable
-- pour une initialisation qui n'a lieu qu'une fois, et il vaut mieux l'ecrire
-- que de laisser croire a une garantie qui n'existe pas.
--
-- HORS de tout bloc `$$`, et c'est obligatoire : psql ne substitue PAS ses
-- variables a l'interieur d'une chaine a dollars. Ecrit dans un `DO $$ ... $$`,
-- le `:'app_password'` arrivait litteralement au serveur, qui repondait
-- « syntax error at or near ":" ». Constate au premier demarrage de la pile.
--
-- Le refus d'un mot de passe vide vit donc dans `docker/init-db.sh`, qui est
-- de toute facon le seul a connaitre la variable d'environnement.
ALTER ROLE n8n_soc WITH PASSWORD :'app_password';

-- ---------------------------------------------------------------------
-- Deduplication des alertes.
--
-- Une meme alerte peut arriver plusieurs fois : reessai reseau de
-- l'emetteur, rejeu manuel, equipement bavard. La traiter deux fois
-- signifierait deux appels au modele, deux demandes d'approbation, et
-- potentiellement deux isolations du meme hote.
--
-- LA CLE PRIMAIRE FAIT LE TRAVAIL. La requete d'ingestion combine un CTE de
-- lecture et un INSERT dans la meme transaction implicite : deux requetes
-- concurrentes ne peuvent pas conclure toutes les deux « nouvelle ».
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soc_ingested_alerts (
  alert_id       text        PRIMARY KEY,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Compte les arrivees suivantes. Un identifiant qui revient cinquante fois
  -- est un defaut chez l'emetteur, et c'est une information qu'on veut voir.
  seen_count     integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS soc_ingested_first_seen_idx
  ON soc_ingested_alerts (first_seen_at DESC);

-- L'application insere et lit, elle ne supprime pas : purger l'historique de
-- deduplication ferait reaccepter des alertes deja traitees.
REVOKE ALL ON soc_ingested_alerts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON soc_ingested_alerts TO n8n_soc;
REVOKE DELETE, TRUNCATE ON soc_ingested_alerts FROM n8n_soc;
