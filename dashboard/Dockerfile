# =============================================================================
# Console MENATER — API + interface, dans une seule image.
# =============================================================================
# UNE SEULE IMAGE, ET C'EST VOULU. L'API sert elle-même les fichiers construits
# (voir `server/static.ts`) : une origine, un verrou d'accès, un déploiement.
# Un nginx à côté aurait signifié deux origines, donc un verrou qui ne protège
# que la moitié de l'application — la question que le projet a déjà tranchée en
# fusionnant VulnPipe.
# =============================================================================

# --- Étape de construction ---------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

# Les manifestes d'abord : tant qu'ils ne changent pas, Docker réutilise la
# couche d'installation. Copier tout le code en premier invaliderait le cache à
# chaque modification de source.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Le typecheck fait partie de la construction : une image qui ne compile pas ne
# doit pas exister. La découvrir au démarrage du conteneur coûte un aller-retour.
RUN npm run typecheck && npm run build

# --- Étape d'exécution -------------------------------------------------------
FROM node:24-alpine AS runtime

# `tini` comme PID 1 : sans lui, Node reçoit les signaux en tant que processus
# d'init et ignore SIGTERM. Un `docker stop` attendrait alors dix secondes
# avant de tuer brutalement — au milieu d'une écriture d'audit, éventuellement.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Uniquement les dépendances d'exécution : `pg` et rien d'autre. Les outils de
# construction n'ont aucune raison d'exister dans une image exposée.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY tsconfig.json ./

# `config.json` porte des secrets et vit dans un volume : le dossier doit
# appartenir à l'utilisateur non privilégié AVANT de basculer dessus.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV MENATER_UI_ROOT=/app/dist \
    MENATER_CONFIG=/data/config.json \
    MENATER_API_PORT=4400

EXPOSE 4400

# Sonde la route d'authentification : elle répond sans session et sans toucher
# à la base. Sonder `/api/snapshot` déclarerait la console en panne
# chaque fois que la base est injoignable, ce qui est précisément le moment où l'on
# a besoin qu'elle tourne.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4400/api/auth/status >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "server/api.ts"]
