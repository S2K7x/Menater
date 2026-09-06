# Journal des nuits

## 2026-08-19

**Sujet** : le scanner IDOR déterministe pouvait encore classer une route
vulnérable comme "saine" sans jamais consulter le LLM — cette fois à cause
d'une liste de noms de méthode exacts qui ratait les conventions ORM
composées.

**Résultat** : PR ouverte (branche `claude/exciting-volta-x4wscq`).

**Ce que j'ai appris** :
- `isDataAccess()` (`src/nodes/idor/scanner.ts`) comparait le nom de chaque
  appel à une liste FIGÉE de noms exacts (`findone`, `findbyid`, `getbyid`...).
  Un nom de méthode réel mais absent de la liste — `findOneBy` (TypeORM),
  `findByIdAndUpdate` (Mongoose), et toute variante composée du même genre —
  n'était pas reconnu comme un accès aux données : `collectDataAccessSites`
  le voyait bien, mais la boucle principale de `scanForIdor` l'ignorait
  purement et simplement (`if (!isDataAccess(...)) continue;`).
- Conséquence : si la MÊME méthode contient à la fois un appel reconnu et
  filtré (ex. `this.db.logs.findOne({ userId })`, pour un log d'accès) et un
  appel non reconnu et NON filtré (ex. `this.db.orders.findOneBy({ id })`,
  la vraie lecture de la ressource), le scanner ne voit que le premier. Le
  garde-fou `scoped && !unscoped && !hasUnresolvedGuard` conclut alors
  `decisive_score: 0.1` ("sain", coût nul) alors que la route est réellement
  vulnérable. Exactement la même famille de faux négatif silencieux que le
  bug corrigé hier soir (voir entrée du 2026-08-18) — cette fois sur le nom
  de la méthode plutôt que sur la fenêtre de recherche du filtre.
- Corrigé en remplaçant la comparaison par égalité exacte par une
  comparaison de PRÉFIXE sur le même jeu de verbes (`find`, `get`, `query`,
  `select`, `fetch`, `load`, `update`, `delete`, `remove`, `destroy`, `save`).
  Tous les noms de la fixture (`findById`, `findOne`) commencent déjà par un
  de ces verbes : aucune régression sur les cas existants, vérifié par les
  283 tests déjà en place plus le nouveau.
- Un faux positif introduit par le préfixe (un nom métier qui commence par
  "get" sans être une requête base) ne peut plus produire un verdict "sain"
  à tort : au pire il ajoute un site "non reconnu comme filtré" qui pousse la
  route en zone grise (coût LLM en plus), jamais l'inverse. C'est la
  direction sûre déjà retenue hier soir.

**À ne pas refaire** :
- Ne pas revenir à une liste de noms exacts "pour plus de précision" sans
  rouvrir ce raisonnement : c'est précisément ce qui a permis à `findOneBy`
  de passer inaperçu.
- Je n'ai PAS tenté d'énumérer davantage de noms ORM exacts (`findBy`,
  `updateOne`, `deleteMany`, méthodes d'agrégation...) : une liste, même
  élargie, reste un jeu au chat et à la souris avec les conventions de nommage
  réelles. Le préfixe couvre la famille au lieu d'un nom précis, mais reste
  heuristique par construction — un verbe métier qui ne commence par aucun de
  ces préfixes (rare mais possible) resterait invisible. Le vrai correctif de
  fond, déjà noté dans `ROADMAP.md`, est un suivi de flux de données plutôt
  qu'un filtre sur le nom de la méthode ; hors de portée d'un changement d'une
  nuit.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test             # 284/284 verts (283 avant + 1 nouveau test, aucun ignoré/affaibli)
npm run build         # web/dist généré, 293 kB / 91 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
le changement est entièrement couvert par les tests hors-ligne (`FakeLlmClient`)
et par un test unitaire du scanner qui n'appelle aucun modèle.

## 2026-08-19

**Sujet** : en mode `incremental_scan`, un commit qui ne touchait qu'un service
ne faisait réanalyser aucune route — VulnPipe répondait « rien à revérifier »
sur le commit qui venait justement d'introduire la faille.

**Résultat** : PR ouverte (branche `nightly/2026-08-19-incremental-service-deps`).

**Ce que j'ai appris** :
- La condition de rattachement dans `selectRoutes` (`src/orchestration/pipeline.ts`)
  était `fichier.includes(route.controller)`. `route.controller` est le NOM DE
  CLASSE (`OrderController`), le fichier est un CHEMIN (`src/order.controller.ts`) :
  la condition ne pouvait jamais être vraie. Ce n'était pas une heuristique
  faible, c'était du code mort — et son commentaire affirmait le contraire
  (« un service modifié rend vulnérables les routes qui l'appellent »). Un
  commentaire qui décrit une intention non implémentée est pire qu'une absence
  de commentaire : il empêche de relire la ligne.
- Le mode incrémental n'avait AUCUN test sur son chemin nominal. Les trois
  tests existants couvraient uniquement les replis (pas de commit, diff
  incalculable), c'est-à-dire les cas où la fonction ne sélectionne rien. Le
  seul endroit capable de produire un faux négatif — décider ce qu'on
  n'analyse PAS — n'était vérifié nulle part. Leçon générale : un test sur les
  branches d'échec d'une fonction de filtrage ne dit rien de son filtre.
- Créer un vrai dépôt git jetable dans un test est bon marché : `git init` +
  deux commits, hors ligne, ~40 ms pour cinq dépôts. Pas besoin de simuler
  `git diff` — c'est justement l'accord entre la forme réelle de sa sortie et
  nos chemins qui cassait.
- `git diff --name-only` renvoie des chemins relatifs à la RACINE DU DÉPÔT,
  pas au `cwd` passé à `execFileSync`. Nos `route.file` sont relatifs à la
  racine INDEXÉE. Sur un monorepo dont on n'indexe qu'un paquet, plus rien ne
  correspondait — deuxième faux négatif, silencieux lui aussi. `--relative`
  aligne les deux et exclut au passage ce qui est hors du dossier indexé.
- `injection_map` (indexeur, Phase 1) suffit à relier une route à ses services,
  transitivement, sans aucun appel LLM ni relecture du disque. Le contexte
  nécessaire existait déjà dans l'index ; il n'était pas consulté.

**À ne pas refaire** :
- Ne pas rétablir de rattachement par ressemblance de noms (chemin contre nom
  de classe, ou `order` contre `OrderController`). C'est ce qui a masqué le
  bug : ça a l'air d'un lien, ça n'en est pas un. L'index sait qui appelle
  qui — il faut le lui demander.
- Piste écartée : traiter un fichier modifié non rattaché à une route comme
  « sans effet » et rester en incrémental. Moins coûteux, mais c'est
  exactement le raisonnement « dans le doute, tout va bien » que ce produit
  ne peut pas se permettre. J'ai pris le repli en scan complet, annoncé par
  un message. Contrepartie assumée et notée dans le ROADMAP : sur un dépôt
  réel, l'incrémental retombera probablement souvent en complet. Il faut le
  MESURER sur un vrai dépôt avant d'affiner — pas le deviner.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test            # 289/289 verts (284 avant + 5 nouveaux, aucun ignoré/affaibli)
npm run build       # web/dist généré, 293 kB / 91 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
la sélection de routes est purement déterministe et se teste hors ligne.

**Note de rebase** : la branche a été rebasée sur `main` après l'arrivée des
PR #2 (page de présentation, réglages) et #3 (préfixes ORM du scanner). Seul
`NIGHTLY_LOG.md` était en conflit — deux nuits datées du même jour, les deux
entrées ont été conservées. Les chiffres ci-dessus sont ceux d'APRÈS rebase ;
les fichiers de code se sont fusionnés sans conflit (les modifications de
`pipeline.ts` par la PR #3 portent sur l'agrégation, pas sur `selectRoutes`).

## 2026-08-18

**Sujet** : le scanner IDOR déterministe pouvait classer une route vulnérable
comme "saine" sans jamais consulter le LLM, à cause d'une vérification de
filtre trop large.

**Résultat** : PR ouverte (branche `claude/exciting-volta-u9ijhz`).

**Ce que j'ai appris** :
- `mentionsUserScope()` (`src/nodes/idor/scanner.ts`) cherchait un champ
  d'identité (`userId`, `ownerId`, ...) dans **tout le corps de la méthode
  englobante** de l'appel base de données, pas seulement près de cet appel.
  Un paramètre `userId` reçu dans la signature mais jamais branché sur le
  filtre — un oubli très courant chez un vibe coder qui a commencé à câbler
  l'ownership check et ne l'a jamais terminé — suffisait à faire matcher le
  texte et à classer `findOne({ id })` comme protégé.
- C'est plus grave qu'un simple faux négatif de LLM : `decisive_score`
  est le chemin qui **court-circuite le LLM**. Un faux positif sur "scoped"
  ici produit une route vulnérable classée saine à coût nul, jamais revue
  par personne — humain ou modèle. C'est exactement le défaut que
  `CLAUDE.md` §3/§4 et le ROADMAP désignent comme le pire possible pour ce
  produit.
- Le test existant ("ne se laisse pas berner par un `req.user.id` utilisé
  seulement pour un log") ne couvrait PAS ce cas : il passait par accident,
  parce que la fixture avait un DEUXIÈME site d'accès (l'appel imbriqué
  `this.db.orders.findOne({ id })` dans `OrderService.findById`) qui restait
  correctement classé "non filtré" et suffisait à empêcher le verdict
  décisif, indépendamment de la mauvaise classification du site parent. Un
  scénario avec un SEUL site d'accès dans la méthode qui reçoit le paramètre
  inutilisé n'était testé nulle part — c'est celui que j'ai ajouté.
- Piste explorée et écartée : faire regarder la fenêtre aussi quelques lignes
  **avant** l'appel (pour reconnaître un `if (!owns) throw` juste au-dessus).
  Abandonné : dans une méthode courte (la majorité des cas réels et de nos
  fixtures), une fenêtre arrière retomberait sur la ligne de signature et
  réintroduirait exactement le bug que je corrige (le paramètre `userId`
  inutilisé redeviendrait visible). Direction retenue : fenêtre strictement
  vers l'avant. Conséquence assumée et documentée dans le ROADMAP — un
  contrôle d'accès écrit en amont de l'appel n'est plus reconnu par le
  scanner déterministe et pousse la route en zone grise (coût LLM) au lieu
  d'un verdict "sain" à coût nul. C'est la direction sûre : dans le doute, on
  demande, on ne conclut jamais à tort qu'une route est protégée.

**À ne pas refaire** :
- Ne pas élargir à nouveau `mentionsUserScope` pour regarder tout le corps de
  la méthode "pour réduire le taux de zone grise" sans re-belier le
  raisonnement ci-dessus : c'est précisément ce qui a causé ce bug.
- Le vrai correctif de fond (suivi de flux de données au lieu d'un
  pattern-matching textuel) n'a pas été tenté cette nuit — hors scope d'un
  changement d'une nuit, nécessiterait de repenser l'indexeur/resolver pour
  exposer les arguments réels d'un appel plutôt qu'un simple nom de méthode
  et une ligne.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test             # 187/187 verts (186 avant + 1 nouveau test, aucun ignoré/affaibli)
npm run build         # web/dist généré, 217 kB / 69 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
le changement est entièrement couvert par les tests hors-ligne (`FakeLlmClient`).
