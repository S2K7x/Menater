# =============================================================================
# VulnPipe — moteur d'analyse de code.
# =============================================================================
# DEUX CONTRAINTES, TROUVEES L'UNE APRES L'AUTRE, ET AUCUNE N'EST EVIDENTE
#
#  1. `tree-sitter` NE FOURNIT PAS DE BINAIRE `linux-arm64`.
#     Ses binaires precompiles couvrent darwin-arm64, darwin-x64, linux-x64 et
#     win32-x64. Sur un hote ARM — un Mac Apple Silicon, un Raspberry Pi —
#     l'image Linux est donc arm64, aucun binaire ne correspond, et npm se
#     rabat sur une compilation depuis les sources.
#
#     Ce n'est pas une histoire de libc : passer d'Alpine a Debian ne change
#     rien, c'est l'ARCHITECTURE qui manque.
#
#  2. NODE 24 EXIGE C++20, `tree-sitter` NE LE DEMANDE PAS.
#     Ses en-tetes V8 imposent `-std=c++20` ; le `binding.gyp` du paquet ne le
#     precise pas. La compilation echoue sur :
#
#         v8config.h:13:2: error: #error "C++20 or later required."
#
#     Node 22 n'a pas cette exigence et compile sans rien changer au paquet.
#     C'est aussi la version minimale pour `--experimental-strip-types`.
#
# ---------------------------------------------------------------------------
# POURQUOI CE SERVICE RESTE SEPARE DE LA CONSOLE
#
# Precisement a cause de ce qui precede. La console n'a qu'UNE dependance
# d'execution (`pg`) et se construit en quinze secondes sur n'importe quel
# hote. Fusionner lui ferait heriter de tout ce fichier — un module natif, une
# chaine de compilation, une version de Node contrainte — pour un service dont
# la file de triage n'a jamais besoin.
#
# Et surtout : une analyse de code qui plante ne doit pas emporter la console
# de triage avec elle. C'est la meme frontiere que dans le code : « fusionne,
# l'interface ; pas fusionne, les moteurs ».
# =============================================================================

# --- Construction : c'est ici, et seulement ici, que vivent les compilateurs --
FROM node:22-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Les manifestes d'abord : tant qu'ils ne changent pas, Docker reutilise la
# couche d'installation — qui coute une compilation de module natif.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Execution ---------------------------------------------------------------
FROM node:22-slim AS runtime

# `tini` comme PID 1 : sans lui, Node recoit les signaux en tant que processus
# d'init et ignore SIGTERM. Un `docker stop` attendrait dix secondes avant de
# tuer brutalement — au milieu d'un scan, eventuellement.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Les modules DEJA COMPILES sont recopies : ni python3, ni make, ni g++ dans
# l'image finale. Une image exposee sur le reseau n'a aucune raison de porter
# une chaine de compilation.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY Prompts ./Prompts
COPY tsconfig.json ./

# Le magasin de cles vit dans un volume : ecrit dans la couche du conteneur,
# il disparaitrait a chaque redeploiement.
RUN mkdir -p /data/.vulnpipe && chown -R node:node /data /app
USER node

ENV VULNPIPE_API_PORT=4319 \
    VULNPIPE_KEYSTORE=/data/.vulnpipe/keys.json

EXPOSE 4319

# Sonde en Node plutot qu'avec wget : `node:slim` ne l'embarque pas, et
# l'installer pour une sonde ajouterait un paquet a une image exposee.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4319/providers').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/orchestration/server.ts"]
