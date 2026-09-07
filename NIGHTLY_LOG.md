# Journal des nuits

*Entries from 2026-09-07 onward are in English, per `NIGHTLY.md`: everything
written in this repository is English. The French entries below are kept as
they were — they are memory about live code, and rewriting them would lose it.*

## 2026-09-07 — Monday · Feature

**Subject**: J0.3, the service ↔ repository inventory — the table that says
which code runs on the machine an alert is about, plus the one consumer that
makes it real: the incident card names it and hands it to the Code tab.

**Result**: PR opened (branch `claude/nightly-2026-09-07-service-inventory`).

**Why this subject**: Monday is the feature night and the roadmap says J0
outranks everything, with J0.3 explicitly ordered before J0.1 and J0.2. The
suite was green on the default branch first (913 tests, typecheck clean), so
the calendar rule did not preempt it. No nightly PR was open.

**What I learned**:

- **`config.json`'s `merge()` cannot hold a list.** It walks the sections of
  the default config and does `{ ...base[section], ...patch[section] }`.
  `typeof [] === 'object'`, so an array section is spread INDEX BY INDEX.
  Measured on the real function before writing a line of the feature:
  saving `[a]` over `[a, b]` yields `{"0":a,"1":b}` — the deleted entry
  survives and the section stops being an array. The inventory is therefore
  `{ entries: [...] }`, one level down, where the spread replaces the key. The
  test that proves it is the one that REMOVES an entry; a test that only adds
  passes either way. Any future list-shaped setting owes the same wrapper.
- **A jump into a tab that is never unmounted needs a key, not an effect.** The
  Code tab stays mounted once opened (unmounting would cut a running scan) and
  `ScanLauncher` takes its target as an INITIAL value, owning the field
  afterwards. So a second alert handing it a second repository changed nothing:
  the tab opened with the previous alert's path in the box, silently and
  plausibly. `key={prefill?.n}` fixes it; an effect writing into the field
  would have re-run the child-before-provider ordering trap this codebase
  already has in its table. Verified by removing the key and watching the test
  go red.
- **A controlled field must not normalise on every keystroke.** The first draft
  of the identifiers textarea split on `\n` and joined the list back into
  `value`. Splitting drops blank lines, which is right on the way out and fatal
  while typing: the newline vanished the instant it was typed, so a machine's
  SECOND address could never be entered — the field silently refused the only
  thing it exists for. Found by re-reading my own diff, not by a test; the test
  came after and was verified red against the old handler. The draft holds raw
  text now and converts once, on save. The dirty check compares the CONVERTED
  value, otherwise a trailing newline would light a permanent "unsaved changes".
- **Rendering the Settings screen with rows in it found the bug above.** An
  inventory editor with no entries is a heading and a button. `CLARITY.md` is
  right about this and it cost nothing to obey: the fixture test that mounts it
  with two services is the same test that now pins the save payload.
- **`AlertCase.source_ip` / `dest_ip` carry `—` for "not recorded"** while
  `host` carries `null`. Anything matching on those three has to treat the dash
  as absent, or one inventory entry named `—` becomes a wildcard for every
  alert with no address.

**Do not redo**:

- **Do not add CIDR ranges, suffix rules or "looks close enough" matching**
  without reopening the reasoning in `server/inventory.ts`'s header. A guessed
  repository sends an analyst to read the wrong code while an incident is open.
  A range is still a declaration rather than a resemblance, so it is the one
  extension worth considering — but it needs its own ambiguity rule (two
  overlapping ranges), which is exactly what exact matching avoids having to
  solve.
- **Do not make the resolver pick between two entries claiming one machine.**
  The save is refused naming the identifier instead, so the store cannot hold
  the ambiguity and the resolver never needs a tie-break.
- **Ruled out: making the card say "not in the inventory" when there is no
  match.** It is true, and it would put a line nobody can act on at the top of
  every incident on an install that has not filled the table in. Absence is
  shown by showing nothing here, because the absence is a fact about our
  configuration and not about the detection — unlike the observables above it,
  which keep their dash.
- **Ruled out for tonight: exposing the field to the assistant and the MCP
  catalogue.** `alertRow` / `alertDetail` pick their fields explicitly, so
  nothing leaked by accident; adding it is a one-line follow-up that touches
  the fenced surface, and it did not belong in a PR that already spans server,
  settings and two tabs.
- **Ruled out: a Postgres table for the inventory.** `sql/` only runs on a
  database's first start, so a new table means a manual `psql` on every
  existing stack — and this is operator-declared configuration, not pipeline
  evidence: it decides nothing irreversible and needs no audit history.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 953 passed | 1 skipped (913 before, +40 new; nothing skipped or weakened)
npm run build       # dist built, 472 kB / 140 kB gzip
```
Two of the new tests were checked RED before the fix they cover: the Code-tab
prefill (key removed → "is REPLACED when a second alert sends another one"
fails) and the identifiers textarea (collapsing handler restored → "accepts a
second identifier typed on a new line" fails). `VulnPipe/` was not touched, so
its suite was not run. No model key and no database in this environment, and
nothing here needs either: the resolver is pure, and the route tests drive
`handleRequest` against a scratch `config.json`.

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
