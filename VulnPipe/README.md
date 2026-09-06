# VulnPipe

**Un scan de sécurité automatique sur ton code, expliqué en langage courant, à chaque commit.**

> 🌍 **L'application est en anglais par défaut, et bascule en français en un
> clic** (bouton `EN / FR` en haut à droite). Voir [Langues](#langues).

VulnPipe est fait pour les *vibe coders* : les gens qui livrent du code écrit
avec l'IA, vite, sans avoir de bagage en sécurité. L'outil cherche les failles,
puis t'explique ce qu'il a trouvé comme le ferait un collègue patient — pas
comme un rapport SAST.

Deux promesses tiennent tout le reste :

1. **Low-cost.** Le gros du travail est fait par des vérifications
   déterministes gratuites et des modèles locaux ou bon marché. Le modèle cher
   n'intervient que sur les cas vraiment douteux — environ 10 à 15 % du volume.
2. **Compréhensible.** Tu ne lis jamais de JSON ni de log. Chaque étape et
   chaque alerte est traduite, avec le *pourquoi*.

---

## Démarrer en trois minutes

```bash
npm install
```

Copie la configuration d'exemple et mets-y au moins une clé :

```bash
cp .env.example .env
```

```
GEMINI_API_KEY=ta-cle
```

Puis :

```bash
npm run dev
```

L'API démarre sur `http://localhost:4319`, l'interface sur
`http://localhost:5173`. Le fichier `.env` est chargé automatiquement — pas de
`source .env` à faire à la main.

Au démarrage, le service affiche exactement ce qu'il a lu :

```
Config : /chemin/vers/.env — 2 variable(s) chargée(s)

Fournisseurs :
  ✅ gemini
  ✅ ollama
  ❌ anthropic — ANTHROPIC_API_KEY absente du fichier .env.
```

> **Tu n'as pas de clé et tu ne veux pas payer ?** Installe [Ollama](https://ollama.com),
> lance `ollama serve`, et mets `VULNPIPE_LLM_PROVIDER=ollama` dans `.env`.
> Tout tourne sur ta machine, gratuitement, en échange d'un peu de lenteur.

---

## Langues

L'interface, les messages d'étape, le devis et le rapport final existent en
**anglais (défaut) et en français**. Le sélecteur `EN / FR` est en haut à
droite, et le choix est mémorisé d'une visite à l'autre.

Le basculement n'est pas cosmétique : la langue part avec chaque appel à
l'API, si bien que **le texte rédigé côté serveur suit** — y compris les
résumés produits par le modèle, dont le prompt reçoit la consigne de langue.
Traduire l'interface sans traduire ce que produit le modèle donnerait un écran
anglais dont chaque alerte serait rédigée en français : le pire des deux
mondes.

Via l'API, la langue se demande avec le champ `locale` :

```bash
curl -X POST localhost:4319/estimate \
  -H 'content-type: application/json' \
  -d '{"target":"/chemin/vers/projet","mode":"full_scan","locale":"fr"}'
```

`en` (défaut) et `fr` sont reconnus ; les variantes régionales (`fr-FR`,
`fr_CA`) aussi. Une langue inconnue retombe sur l'anglais sans faire échouer
la requête.

**Ce qui reste en anglais quelle que soit la langue choisie :** les messages
techniques — `error.message`, journaux serveur, contenu replié derrière « voir
le détail technique ». Un message d'erreur d'API finit copié-collé dans un
moteur de recherche, où la version anglaise est celle qui trouve des réponses.
Les commentaires du code source sont eux aussi restés en français, langue de
travail du dépôt.

Ajouter une langue : `src/i18n/messages.ts` (serveur) et
`web/src/i18n/dictionary.ts` (interface). Les deux catalogues sont typés, donc
une clé ajoutée sans traduction **ne compile pas** — c'est le seul garde-fou
qui tienne dans la durée contre l'écran à moitié traduit.

---

## Ce que tu peux analyser

Trois formes de cible, dans le même champ :

| Cible | Exemple | Ce qui se passe |
|---|---|---|
| **Un dossier** | `/Users/moi/mon-projet` | Tout ce qu'il contient est passé en revue. |
| **Un fichier seul** | `/Users/moi/projet/src/orders.controller.ts` | Le projet autour est **lu** pour comprendre le contexte, mais seul ce fichier est **audité**. Rapide et peu cher. |
| **Un dépôt GitHub public** | `https://github.com/moi/projet` | Une copie temporaire est récupérée, analysée, puis supprimée. |

La distinction « lu » / « audité » du fichier seul n'est pas un détail : sans
lire le reste du projet, chaque appel à un service ressortirait en « il manque
du contexte », et tu aurais un rapport de faux doutes.

Un dépôt privé ne marchera pas — VulnPipe n'a pas tes accès GitHub. Clone-le
d'abord, puis analyse le dossier.

---

## Le devis : savoir avant de payer

Cliquer sur **Estimer puis analyser** ne lance rien. Ça produit d'abord un
devis :

```
Temps          Coût            Adresses vérifiées    Appels à l'IA
9 s – 19 s     Non chiffrable  4                     2 – 3
                               2 sans IA, 2 avec     c'est le seul poste facturé
```

**Ce devis n'est pas une devinette.** Il rejoue la pipeline réelle jusqu'au
dernier pas gratuit :

| Étape | Rejouée pour le devis ? |
|---|---|
| Lecture et indexation du code | ✅ pour de vrai |
| Reconstitution des liens entre fichiers | ✅ pour de vrai |
| Vérifications déterministes | ✅ pour de vrai |
| Construction des questions à poser au modèle | ✅ pour de vrai |
| **Envoi des questions au modèle** | ❌ **jamais** — c'est la seule étape payante |

Conséquence : le nombre d'appels facturés est **connu**, pas supposé. Les
vérifications déterministes tranchent déjà une partie des adresses, et on sait
lesquelles avant d'avoir dépensé un centime.

Sur un gros projet, seules les douze premières adresses sont mesurées pour de
vrai et le reste est extrapolé — c'est écrit dans le devis, avec le nombre.

### Pourquoi le coût affiche parfois « non chiffrable »

Parce qu'on refuse d'inventer un prix. Les tarifs des fournisseurs changent
tous les quelques mois ; une grille codée en dur dans ce dépôt afficherait un
jour un chiffre faux avec l'autorité d'une facture.

Les seuls prix écrits en dur sont ceux qui valent zéro **par construction** et
ne peuvent pas devenir faux : un modèle qui tourne sur ta machine (`ollama`, un
serveur `custom`) et le palier `openrouter/free`.

Pour tout le reste, renseigne ton tarif — en dollars par million de tokens,
entrée puis sortie, tel qu'affiché sur la page de facturation de ton
fournisseur :

```
VULNPIPE_PRICE_GEMINI="0.30/2.50"
VULNPIPE_PRICE_ANTHROPIC="3/15"
VULNPIPE_PRICE_OPENAI="1.25/10"
```

Sans ça, tu vois quand même le volume de travail et la durée : seul le montant
en dollars manque.

L'estimation de durée, elle, s'améliore toute seule : les latences réellement
mesurées pendant tes scans remplacent progressivement les valeurs de départ.

---

## Ce qui se passe pendant l'analyse

Pendant que ça tourne, tu vois **le travail**, pas seulement une barre :

- l'adresse en cours d'examen, nommée (`GET /orders/:id`) ;
- les verdicts qui tombent un par un, avec leur code couleur ;
- les compteurs vivants : temps écoulé, appels à l'IA, dépense cumulée ;
- lesquels des verdicts ont été rendus **gratuitement**.

C'est un choix délibéré. Un scan de sécurité qui tourne trois minutes en
silence ressemble à un logiciel bloqué ; le même scan qui montre son travail
ressemble à quelqu'un qui bosse pour toi. Et un compteur de dépense visible
pendant la course est le seul moyen de couper un scan qui dérape.

---

## Comment ça marche, étape par étape

```
[ Ta cible : dossier · fichier · dépôt GitHub ]
       │
       ▼
[ 1. INDEXEUR ]      Tree-sitter : liste les adresses, les classes, les appels
       │
       ▼
[ 2. SERVEUR MCP ]   Expose le code par adresse : get_context(route, profondeur)
       │
       ├──► [ 3. Node IDOR ]     ┐  en parallèle, chacun :
       ├──► [ Node XSS ]  (à venir) │  scanner déterministe (gratuit)
       ├──► [ Node SQLi ] (à venir) │  + modèle local/bon marché si besoin
       └──► [ Node Config ] (à venir)┘  -> verdict + score de confiance
       │
       ▼
[ 4. AGRÉGATEUR ]    Déterministe, sans IA : dédoublonne, score, filtre
       │             ne fait remonter que 10-15 % du volume
       ▼
[ 5. ARBITRE ]       Un modèle plus poussé tranche les cas douteux
       │
       ▼
[ 6. RAPPORT ]       En français, orienté « ce qui peut m'arriver et comment je corrige »
```

### 1. Indexeur — *dresser la liste de ce qu'il y a à protéger*

**Ce qu'il fait :** il lit ton code et repère chaque adresse de ton application
(chaque route, chaque point d'entrée d'API), avec le code qui la traite.

**Pourquoi cette étape :** on ne peut pas chercher une faille sans savoir où
chercher. C'est le tour de la maison avant de vérifier les serrures.

**Pourquoi Tree-sitter et pas le compilateur TypeScript :** parce qu'on veut
pouvoir ajouter Python et Go plus tard avec le même moteur. Le prix à payer est
une résolution parfois imparfaite — deux méthodes `findById` dans deux services
différents ne sont pas toujours distinguables. Ce n'est pas un bug caché : ces
cas sont marqués `ambiguous_logic` et confiés au modèle, qui a le contexte pour
trancher.

### 2. Serveur MCP — *relier les morceaux*

**Ce qu'il fait :** pour une adresse donnée, il rassemble le code du handler,
le code des services qu'il appelle, et le code des protections déclarées
(`@UseGuards(...)`).

**Pourquoi cette étape :** une adresse toute seule ne dit rien. `getOrder(id)`
n'est dangereux que selon ce que fait le service derrière et selon ce que
vérifie la garde devant. Il faut suivre le fil de l'interrupteur jusqu'à
l'ampoule.

**Un point qui compte :** une route n'est pas identifiée par son adresse seule.
`GET /orders/:id` et `DELETE /orders/:id` sont deux surfaces de risque
différentes. La clé est le couple (verbe, adresse) — sinon on auditerait le
mauvais code sans jamais s'en apercevoir.

### 3. Nodes de détection — *chercher, gratuitement d'abord*

Chaque node fonctionne en deux temps :

1. **Un scanner déterministe** (gratuit, instantané). S'il peut conclure seul,
   il conclut : une route sans identifiant de ressource n'a pas de surface
   IDOR, point. Aucun appel payant.
2. **Un modèle**, uniquement si le premier n'a pas tranché. Le prompt impose un
   raisonnement étape par étape avant le score, et une grille de calibration.

Le node rend un **score de confiance**, pas un booléen. Un « oui/non » sur du
code ambigu produit soit des faux positifs qu'on apprend à ignorer, soit des
faux négatifs dangereux.

Il distingue aussi **deux natures de doute**, ce qui change la suite :

- `missing_context` — « il me manque du code » (une garde dont le corps est
  introuvable). Là, redemander du contexte plus profond peut suffire, sans
  déranger l'arbitre.
- `ambiguous_logic` — « j'ai tout le code, mais le jugement métier est
  difficile ». Là, seul un modèle plus fort peut aider.

Des garde-fous déterministes corrigent le modèle après coup, et **tracent
chaque correction**. Un modèle qui renvoie `confidence: 0.9` avec
`reason: "missing_context"` se contredit ; on le ramène en zone grise, et on
écrit pourquoi. Une correction silencieuse rendrait la calibration impossible à
mesurer.

### 4. Agrégateur — *trier sans IA*

**Ce qu'il fait :** il dédoublonne, il pondère selon le contexte (une route
publique n'a pas le même poids qu'une route `/admin/*`), et il répartit selon
le score :

| Score | Décision | Coût |
|---|---|---|
| `0.0 – 0.3` | Sain. On s'arrête là. | gratuit |
| `0.4 – 0.7` | Zone grise → envoyé à l'arbitre. | payant |
| `0.8 – 1.0` | Quasi certain → alerte directe. | gratuit (arbitrage optionnel) |

**Pourquoi cette étape n'utilise aucune IA :** c'est elle qui protège ton
budget. Confier le tri à un modèle reviendrait à payer pour décider ce qu'on va
payer. Le tri est déterministe, donc gratuit, donc reproductible.

### 5. Arbitre — *la seconde paire d'yeux, sur 15 % du volume*

**Ce qu'il fait :** un modèle plus capable relit uniquement ce que
l'agrégateur lui a transmis, avec le contexte complet, et tranche.

**Pourquoi cette étape :** c'est le compromis central du produit. Faire relire
tout par le gros modèle serait excellent et hors de prix ; ne rien faire
relire serait gratuit et plein de faux positifs. On paie le bon modèle
uniquement là où il change quelque chose.

### 6. Rapport — *en français, pas en jargon*

Chaque alerte porte un `plain_language_summary` : ce qu'un attaquant pourrait
concrètement faire, et comment corriger. Le JSON technique existe toujours,
mais il reste replié tant que tu ne le demandes pas.

> La route `/orders/:id` récupère une commande uniquement par son numéro, sans
> vérifier qu'elle appartient bien à l'utilisateur connecté. N'importe qui
> connecté peut donc lire les commandes de n'importe qui d'autre en changeant
> juste le numéro dans l'URL.

---

## Les deux modes de scan

| | `Tout le projet` | `Seulement ce qui a changé` |
|---|---|---|
| Quand | Premier scan d'un projet | À chaque commit |
| Ce qui est analysé | Toutes les adresses | Les adresses touchées par le diff |
| Coût | Le plus élevé | Le mode « low-cost du quotidien » |

Si le diff n'est pas calculable — pas de commit fourni, dépôt non versionné,
commit introuvable — VulnPipe **retombe sur un scan complet et te le dit**. Un
incrémental silencieusement dégradé en complet ferait exploser la facture sans
prévenir ; l'inverse te laisserait croire à une couverture que tu n'as pas.

---

## Choisir son moteur d'IA

Six fournisseurs, changeables **à chaud** depuis l'onglet Réglages, sans
redémarrer :

| Fournisseur | Clé | Note |
|---|---|---|
| `gemini` | `GEMINI_API_KEY` | Défaut. Une seule clé, peu coûteux. |
| `ollama` | — | Local, gratuit, plus lent. Exige `ollama serve`. |
| `anthropic` | `ANTHROPIC_API_KEY` | Le plus fort en arbitrage. |
| `openai` | `OPENAI_API_KEY` | |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/free` par défaut : tarif nul garanti. |
| `custom` | `VULNPIPE_LLM_BASE_URL` | Tout serveur compatible OpenAI (LM Studio, vLLM…). |

Deux rôles se règlent séparément :

```
VULNPIPE_LLM_PROVIDER=gemini       # recherche de failles (le gros du volume)
VULNPIPE_MASTER_PROVIDER=anthropic # arbitrage (10-15 % du volume)
```

**Si le fournisseur configuré n'a pas sa clé, VulnPipe bascule sur un
fournisseur utilisable et te le dit** en haut de l'écran. Sans ce repli, un
scan échouait à l'arbitrage — c'est-à-dire *après* avoir déjà payé toute la
phase de détection.

Le sélecteur refuse aussi de basculer vers un fournisseur sans clé : mieux vaut
un refus immédiat qu'une panne au milieu d'un scan.

---

## L'onglet Réglages

Deux natures de réglage, annoncées comme telles sur chaque bloc — sans cette
distinction, on croit régler son confort de lecture et on modifie ce que la
pipeline facture.

**Appliqué sur le serveur** (vaut pour tous les onglets ouverts) :

| Réglage | Effet |
|---|---|
| Moteur de détection / d'arbitrage | Voir la section précédente. |
| Contournement de l'arbitrage | Les findings au-dessus de `0.7` vont droit au rapport, sans repasser par le modèle payant. Plus rapide et moins cher — mais c'est aussi l'arbitre qui rédige le résumé en langage clair, donc le rapport est plus brut. |
| Seuils de confiance | Affichés d'après la réponse du serveur (`GET /settings`), jamais recopiés dans l'interface. |

**Gardé dans le navigateur** (préférences personnelles, `localStorage`) :

| Réglage | Effet |
|---|---|
| Cible et étendue par défaut | Pré-remplit le lanceur ; la dernière cible peut être mémorisée. |
| Seuil d'acceptation automatique | Sous ce montant, le devis est accepté sans demander. `0` par défaut, donc désactivé : rien n'est dépensé sans un geste explicite tant que tu n'as pas fixé toi-même une limite. Un devis non chiffrable n'est jamais accepté tout seul. |
| Détail technique / explications ouverts | Confort de lecture, ne change rien à ce qui est analysé. |
| État du service et des moteurs | Ce que l'interface arrive à joindre, avec la raison quand une clé manque. |

---

## Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `npm run dev` | API + interface web (le mode courant) |
| `npm run serve` | API seule |
| `npm run web` | Interface seule |
| `npm test` | Toute la suite de tests |
| `npm run typecheck` | Vérification des types |
| `npm run index -- <dossier>` | Indexation seule, pour inspecter le résultat |
| `npm run e2e` | Scan de bout en bout sur le projet d'exemple |
| `npm run bench` | Mesure du rappel du node IDOR |

### L'API en direct

```bash
# Devis — ne dépense rien
curl -X POST localhost:4319/estimate \
  -H 'content-type: application/json' \
  -d '{"target":"/chemin/vers/projet","mode":"full_scan"}'

# Lancer (reprend le devis, donc sans réindexer ni recloner)
curl -X POST localhost:4319/webhook \
  -H 'content-type: application/json' \
  -d '{"target":"/chemin/vers/projet","mode":"full_scan","estimate_id":"est-..."}'

# Suivre en direct
curl -N localhost:4319/runs/<run_id>/events

# Résultat complet
curl localhost:4319/runs/<run_id>
```

`repo_path` reste accepté à la place de `target`, pour les webhooks Git déjà
configurés. Ajoute `"locale": "fr"` à n'importe laquelle de ces requêtes pour
obtenir les réponses en français.

---

## Configuration complète

```bash
# --- Moteur ---
VULNPIPE_LLM_PROVIDER=gemini          # gemini|ollama|anthropic|openai|openrouter|custom
VULNPIPE_LLM_MODEL=                   # surcharge du modèle (optionnel)
VULNPIPE_MASTER_PROVIDER=anthropic    # arbitre
VULNPIPE_MASTER_MODEL=

# --- Clés ---
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=                   # OPEN_ROUTER_API_KEY est aussi accepté
OLLAMA_HOST=http://localhost:11434
VULNPIPE_LLM_BASE_URL=                # pour provider=custom

# --- Tarifs, pour chiffrer les devis (dollars par million de tokens) ---
VULNPIPE_PRICE_GEMINI="0.30/2.50"     # entrée/sortie
VULNPIPE_PRICE_ANTHROPIC="3/15"

# --- Service ---
PORT=4319
REDIS_URL=                            # défini => BullMQ, sinon file en mémoire
```

`.env.local` est lu en premier et prime sur `.env`. Une variable déjà définie
dans ton shell gagne toujours sur les deux : un `.env` oublié ne doit jamais
écraser les secrets d'un déploiement.

---

## Ce qui n'est pas encore là

- **Une seule famille de failles est couverte : IDOR.** XSS, injection SQL et
  mauvaise configuration viennent ensuite — l'orchestration les attend déjà,
  il ne manque que les nodes.
- **JS/TS uniquement.** Le moteur est prévu pour accueillir Python et Go.
- **Pas de multi-tenant ni de facturation.** Usage local, un projet à la fois.
- **Pas de dépôts privés.** Clone-les d'abord.
- **Deux langues seulement** (anglais, français). L'ossature accepte les
  suivantes sans changement de structure.

## Choix d'architecture, et ce qu'ils coûtent

| Choix | Pourquoi | Ce qu'on accepte en échange |
|---|---|---|
| Tree-sitter, pas le compilateur TS | Agnostique au langage | Résolution parfois ambiguë — signalée, jamais devinée |
| File abstraite (mémoire par défaut, BullMQ si `REDIS_URL`) | Le MVP démarre sans installer Redis | Pas de concurrence multi-process sans Redis |
| Index en JSON, pas de base graphe | Suffisant à ce volume | À revoir sur de très gros dépôts |
| `node:http`, pas Express | Cinq routes ne justifient pas une dépendance | Routage écrit à la main |
| Coût réel jamais estimé (seulement les devis le sont) | Un chiffre inventé est pire que pas de chiffre | Il faut renseigner ses tarifs soi-même |

---

## Documentation interne

- [`CLAUDE.md`](CLAUDE.md) — les décisions d'architecture et leurs raisons
- [`ROADMAP.md`](ROADMAP.md) — l'état d'avancement, phase par phase
- [`Prompts/`](Prompts/) — les spécifications de chaque phase
