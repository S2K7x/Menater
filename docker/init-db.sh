#!/bin/sh
# =============================================================================
# Applique le schema MENATER au premier demarrage de la base.
# =============================================================================
# POURQUOI UN SCRIPT PLUTOT QUE DE MONTER `sql/` DIRECTEMENT
#
# Postgres execute tout ce qu'il trouve dans `/docker-entrypoint-initdb.d/`,
# mais `01-role-and-dedup.sql` a besoin d'une variable de session pour poser le
# mot de passe applicatif — et `psql -f` ne permet pas de la passer autrement
# qu'en ligne de commande.
#
# La passer par `-v` plutot que de l'ecrire dans le SQL evite qu'elle finisse
# dans le depot ou dans le `docker-compose.yml`. Elle reste visible cote
# serveur au moment du `ALTER ROLE` — voir le commentaire dans le fichier SQL,
# qui le dit plutot que de laisser croire a une garantie qui n'existe pas.
# =============================================================================
set -e

# LE GARDE VIT ICI, pas dans le SQL : psql ne substitue pas ses variables a
# l'interieur d'un bloc `$$`, et ce script est de toute facon le seul a
# connaitre la variable d'environnement.
#
# Un role applicatif sans mot de passe est une porte ouverte. Mieux vaut
# refuser d'initialiser que demarrer une base ouverte.
if [ -z "${MENATER_DB_PASSWORD}" ]; then
  echo "[menater] ERREUR : MENATER_DB_PASSWORD est vide." >&2
  echo "[menater] Le role applicatif n'aurait pas de mot de passe." >&2
  echo "[menater] Copier .env.example vers .env et renseigner la valeur." >&2
  exit 1
fi

echo "[menater] application du schema…"

for file in /docker-entrypoint-initdb.d/sql/*.sql; do
  echo "[menater]   $(basename "$file")"
  # `ON_ERROR_STOP` : sans lui, psql poursuit apres une erreur et la base
  # demarre avec un schema a moitie applique — l'application tourne alors
  # jusqu'a toucher la table manquante, des jours plus tard.
  psql -v ON_ERROR_STOP=1 \
       -v "app_password=${MENATER_DB_PASSWORD}" \
       --username "$POSTGRES_USER" \
       --dbname "$POSTGRES_DB" \
       -f "$file"
done

echo "[menater] schema applique."
