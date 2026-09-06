> **ARCHIVE — plus tenue à jour.**
>
> Depuis la fusion de l'interface dans la console MENATER, il n'y a plus qu'une
> feuille de route : [`../ROADMAP.md`](../ROADMAP.md). Ce qui reste à faire côté
> analyse de code y vit sous les entrées `V*`.
>
> Ce fichier est conservé pour son historique : les décisions d'architecture,
> les mesures et les pièges rencontrés phase par phase gardent leur valeur.

# VulnPipe — Roadmap

Cocher au fur et à mesure. Chaque phase correspond à un fichier
`PHASE_N_*.md` à donner tel quel à Claude Code dans une nouvelle session.

- [x] **Phase 1 — Indexeur Tree-sitter** ✅ livrée
      Extraction AST, routes, symbol table, call graph local.
      Livrable : script Node.js testé sur un vrai contrôleur NestJS/Express,
      qui produit un JSON structuré et validé (pas supposé, vérifié en sortie réelle).

      Fichiers : `src/indexer/indexer.ts`, `src/indexer/queries.ts`,
      `src/indexer/cli.ts`, `src/indexer/indexer.test.ts`,
      `scripts/probe-treesitter.cjs`, `scripts/probe-shapes.cjs`.
      Commandes : `npm test` (16/16 verts), `npm run typecheck`,
      `npm run index -- <fichier.ts>`, `npm run probe`.

      **API tree-sitter réellement observée** (bindings NATIFS, pas WASM) :
      `tree-sitter@0.21.1` + `tree-sitter-typescript@0.23.2` sur node v26.5.0.
      `query.matches()` renvoie un **Array** de `{ pattern, captures: [{ name, node }] }`,
      `name` **sans** le `@`. Dump complet recopié en tête de `indexer.ts`.

      **Limitations découvertes en cours de route (à traiter en Phase 2+)** :
      1. Les décorateurs de méthode ne sont **pas** dans le sous-arbre du
         `method_definition` : ce sont des frères précédents du `class_body`
         (champ `decorator:`). Toute nouvelle query doit en tenir compte.
      2. Résolution **mono-fichier uniquement** : `injected_type` donne la classe
         (`OrderService`), pas le corps de la méthode. Le contenu réel de
         `findById` est hors de portée — c'est précisément le job du serveur MCP
         (Phase 2), qui consommera `symbol_table` + `injection_map`.
      3. Injection non résolue si le type n'est pas un `type_identifier` simple
         (générique, union, `@Inject(TOKEN)`) → `resolution: "unresolved"` +
         entrée dans `index_warnings`. À mapper sur `reason: "missing_context"`.
      4. `base_path` ne gère qu'un `@Controller('x')` littéral : pas de constante
         importée, pas de tableau de paths, pas de `@Controller({ path })`.
      5. Liste de guards **codée en dur** (`UseGuards`, `Roles`, `Auth`…) : un
         guard maison au nom exotique sera vu comme absent. Choix conservateur —
         mieux vaut un faux positif remonté au node IDOR qu'une vuln masquée.
      6. Un seul fichier à la fois, pas encore de walk de repo ni de mode
         `incremental_scan` par `git diff`.
      7. `npm` bloque les install scripts (`allow-scripts`) : les bindings natifs
         ont fonctionné via prebuilds. Si un `npm ci` échoue sur une autre machine,
         lancer `npm approve-scripts tree-sitter tree-sitter-typescript`.

- [x] **Phase 2 — Serveur MCP** ✅ livrée
      Expose l'index de la Phase 1 via un tool `get_context(route, depth)`.
      Livrable : serveur MCP fonctionnel, testé avec un client MCP minimal.

      Fichiers : `src/mcp-server/server.ts`, `src/mcp-server/resolver.ts`,
      `src/mcp-server/repo-index.ts`, `src/mcp-server/server.test.ts`,
      `scripts/probe-mcp.mjs`.
      Commandes : `npm test` (40/40 verts), `npm run mcp -- <dossier>`.

      **API SDK réellement observée** : `@modelcontextprotocol/sdk@1.30.0`,
      `zod@4.4.3`. `server.tool()` est déprécié → `registerTool(name, config, cb)`.
      `inputSchema` attend un **ZodRawShape**, pas un `z.object()`. `callTool()`
      renvoie `{ content, structuredContent }` et `isError` vaut `undefined`
      en succès (tester `=== true`). Une erreur de validation ne throw pas :
      elle revient en `isError: true` avec `-32602`, handler jamais appelé.

      **Bloqueur corrigé — la Phase 1 n'indexait que les `@Controller`.**
      La spec disait « résoudre via la symbol table de la Phase 1 », mais cette
      table ne contient que des *sites d'appel*, jamais la *définition* de
      `OrderService`. Ajout de `ClassDefinition` / `indexClass()` (indexation de
      toute classe) + `repo-index.ts` (parcours de dossier). Sans ça, le
      resolver n'avait littéralement rien à résoudre.

      **Trou corrigé dans l'indexeur Phase 1** : les queries `INJECTED_CALL` /
      `LOCAL_CALL` étaient limitées à `this.x.y()` sur exactement deux niveaux
      et rataient **silencieusement** `this.db.orders.findOne({ id })` — vérifié :
      0 match — c'est-à-dire le signal IDOR le plus important. Remplacées par
      une `MEMBER_CALL_QUERY` générique + classification en JS.

      **Écarts assumés par rapport à `PHASE_2_MCP_SERVER.md`** (tous testés) :
      1. **Résolution des guards.** `@UseGuards(OwnershipGuard)` est un
         décorateur, pas un appel : il n'apparaît jamais dans `local_call_graph`,
         donc la spec suivie à la lettre ne lit jamais `ownership.guard.ts`. Or
         c'est ce code qui décide du verdict IDOR. Ajout de `resolved_guards`.
      2. **`http_method` dans `get_context`.** Une route n'est pas unique :
         `GET /orders/:id` et `DELETE /orders/:id` coexistent. Sans le verbe, on
         analysait silencieusement le mauvais handler. Collision → erreur
         explicite, jamais de choix au hasard.
      3. **Protection anti-cycle.** La récursion `depth` de la spec n'a aucune
         garde : `A.f -> B.g -> A.f` part en stack overflow. Garde **par chemin**
         et non globale — un set global amputait la branche principale quand le
         guard atteignait `findById` en premier (attrapé par un test).
      4. **Budget d'octets** (`byte_budget`, défaut 24 000) avec troncature
         signalée. La promesse n°1 de `CLAUDE.md` est le low-cost : une
         récursion non bornée fait exploser le contexte du LLM local. Un même
         corps n'est facturé qu'une fois même s'il apparaît sur deux branches.
      5. **`plain_language_summary`** sur chaque réponse — exigé par
         `CLAUDE.md` §4, totalement absent de la spec Phase 2.
      6. **`reason: missing_context | ambiguous_logic`** mappé sur
         `resolution_status` (`CLAUDE.md` §3), pour que les nodes de la Phase 3
         sachent s'il faut redemander du contexte ou escalader vers Claude.
      7. **Tool `list_routes`** ajouté : sans lui un node de détection n'a aucun
         moyen de savoir quelles routes existent.

      **Limitations restantes (Phase 3+)** :
      - Résolution par **nom de classe**, pas par graphe d'imports : deux classes
        homonymes → `ambiguous` (correct mais imprécis ; lire les `import`
        lèverait l'ambiguïté).
      - `this.db.orders.findOne()` reste `not_found` : l'ORM n'est pas modélisé.
        Le receveur textuel est conservé, c'est au node IDOR d'en tirer parti.
      - Guards résolus par convention de nom `canActivate` (NestJS) ; les
        middlewares Express et les intercepteurs globaux ne sont pas couverts.
      - Index en mémoire, reconstruit à chaque démarrage : pas encore de cache
        ni de mode `incremental_scan` par `git diff`.
      - **Node strip-only** ne supporte pas les *parameter properties* TS
        (`constructor(readonly x: string)`) : Vitest les transpile, le CLI
        plante. Ne pas en réintroduire.

- [x] **Phase 3 — Nodes de détection locaux (IDOR en premier)** ✅ livrée
      Scanner déterministe + LLM avec prompt calibré
      (Chain-of-Thought forcé, grille de score, JSON structuré).
      Livrable : node IDOR fonctionnel end-to-end sur un cas de test connu
      (1 cas vulnérable, 1 cas sain, 1 cas "zone grise").

      Fichiers : `src/nodes/idor/{prompt,scanner,node,node.test}.ts`,
      `src/nodes/shared/mcp-client.ts`,
      `src/nodes/shared/llm/{types,gemini,ollama,anthropic,openai-compatible,factory,fake}.ts`,
      `scripts/{probe-ollama.mjs,probe-gemini.mjs,probe-openai-compatible.mjs,bench-idor.ts}`.
      Commandes : `npm test` (70/70), `npm run bench`, `npm run typecheck`.

      **SCORES RÉELS — `npm run bench` sur gemini-3.5-flash, temperature 0**
      | Cas | Attendu | Obtenu | Appels LLM |
      |---|---|---|---|
      | 1 — vulnérable évident | ≥ 0.8 | **1.0** (reason null) | 1 |
      | 2 — sain (`{id, userId}`) | ≤ 0.3 | **0.1** (reason null) | **0** |
      | 3 — zone grise (guard non résolu) | 0.4–0.7 + missing_context | **0.6** + missing_context | 1 |
      | 4 — pas de surface d'attaque | ≤ 0.3 | **0.05** | **0** |

      4/4 au premier essai, sans réglage de prompt. Les 2 exemples few-shot
      n'ont pas été nécessaires (activables via `includeFewShot`).
      Coût : **2 appels LLM pour 4 routes** — 1460 tokens entrée, 842 sortie,
      536 de raisonnement.

      **Couche LLM multi-fournisseurs** (demande explicite, hors spec) :
      `VULNPIPE_LLM_PROVIDER` = `gemini` (défaut) | `ollama` | `anthropic` |
      `openai` | `openrouter` | `custom`. Les nodes ne connaissent qu'un
      `LlmClient` ; changer de moteur ne touche aucune ligne de détection.
      Voir `.env.example`.

      **API réellement observées** :
      - *Gemini* : `POST /v1beta/models/{m}:generateContent`, auth par en-tête
        `x-goog-api-key`. **Sans `responseSchema`, la réponse est de la prose
        markdown** et `JSON.parse` échoue — la sortie structurée est une
        condition de fonctionnement, pas une optimisation. `thoughtsTokenCount`
        est le vrai poste de coût : 634 tokens de raisonnement pour 104 de
        réponse ; `thinkingLevel: 'low'` le divise par 2 et fait passer la
        latence de 3,7 s à 2,5 s. `temperature: 0` est déterministe (vérifié).
        Une clé invalide sort en **400 INVALID_ARGUMENT**, pas en 401.
      - *Ollama* (qwen3.5:9b) : `think: false` supprime le champ
        `message.thinking` et fait passer l'appel de 8,9 s à 2,9 s.
        `format: 'json'` seul **ne suffit pas** — score renvoyé à `100.0` au
        lieu de `1.0` ; il faut un JSON Schema complet. Le serveur local peut
        tomber en cours de série (observé) → mappé en `unavailable`, jamais
        en verdict.
      - *Anthropic* : SDK officiel. **`temperature` est refusé (400)** sur les
        modèles récents — piège n°1 d'une couche multi-fournisseurs, le champ
        est ignoré ici et non transmis. Prefill assistant également refusé →
        `output_config.format`.

      **Écarts assumés par rapport à `PHASE_3_DETECTION_NODE_IDOR.md`** :
      1. **Scanner déterministe ajouté** (`scanner.ts`). `CLAUDE.md` §2 le
         prévoit dans chaque node, les livrables de la phase l'avaient perdu.
         Sans lui, *chaque* route paie un appel LLM, y compris les routes
         trivialement saines — ce qui contredit la promesse n°1. Mesuré :
         2 routes sur 4 tranchées à coût nul.
      2. **Section `[CONTRÔLE D'ACCÈS DÉCLARÉ]` ajoutée au prompt.** Le
         template imposé n'a que `[ROUTE ET HANDLER]` et `[CALL GRAPH RÉSOLU]`.
         `@UseGuards(...)` étant un décorateur et non un appel, il n'apparaît
         dans aucun call graph : sans cette section, tout le travail de
         résolution des guards de la Phase 2 est jeté et le modèle ne peut pas
         distinguer une route protégée d'une route qui ne l'est pas.
      3. **Retry conditionnel.** La spec demande de rappeler
         `get_context(depth+1)` dès que `reason === "missing_context"`. Appliqué
         tel quel c'est souvent une dépense pure : si le contexte manque parce
         qu'une classe est absente de l'index, descendre d'un niveau ne la fera
         pas apparaître. On ne retente que si un appel déjà résolu a des appels
         sortants non développés (`couldDeepenHelp`), et une seule fois.
      4. **Règle de couplage score/reason + garde-fous déterministes.** Mesuré
         sur gemini-3.5-flash : `confidence_score: 0.9` avec
         `reason: "missing_context"` — contradictoire. La grille l'implique
         sans l'imposer. Le couplage est écrit dans le prompt *et* vérifié en
         code après coup, chaque correction étant tracée dans `adjustments`.
      5. **Référence corrigée** : la spec renvoie à « les 2 exemples few-shot
         mentionnés dans `CLAUDE.md` ». Ils n'y figurent nulle part — la
         référence est fausse. Ils ont donc été rédigés, et rendus optionnels
         pour pouvoir mesurer leur effet plutôt que de le supposer.
      6. **Tests déterministes + banc d'essai séparés.** La spec demande
         d'exécuter les 3 cas contre un vrai modèle *dans les tests*. Une suite
         qui tape le réseau est lente, coûteuse, échoue sans clé et teste le
         modèle plutôt que le node. `npm test` utilise un faux client ;
         `npm run bench` fait la calibration réelle, et ses scores sont
         recopiés en tête de `node.test.ts`.

      **Limitations restantes** :
      - `openai-compatible.ts` est **écrit sans observation réelle** (aucune clé
        OpenAI/OpenRouter disponible). Lancer
        `scripts/probe-openai-compatible.mjs` et recopier la sortie avant de
        router du trafic dessus.
      - Le scanner ignore les commentaires (un `// TODO: ajouter le userId`
        faisait passer une route vulnérable pour saine — bug attrapé par un
        test). Il reste heuristique : noms de méthodes et de champs codés en
        dur, pas de suivi de flux de données.
        **[corrigé la nuit du 2026-08-18, voir NIGHTLY_LOG.md]** Le point le
        plus dangereux de cette heuristique a été resserré : `mentionsUserScope`
        cherchait le champ d'identité dans TOUT le corps de la méthode
        englobante plutôt que près de l'appel — un paramètre `userId` reçu
        mais jamais branché sur le filtre suffisait à déclencher le
        `decisive_score` "sain" et à court-circuiter jusqu'au LLM. La
        vérification est maintenant bornée à une fenêtre de lignes qui suit
        l'appel, jamais en arrière. Reste non couvert par construction (choix
        assumé, direction sûre) : un contrôle d'accès écrit en amont de
        l'appel (`if (!owns(id, userId)) throw ...`) n'est plus reconnu comme
        une protection par le scanner déterministe — la route bascule en zone
        grise (coût LLM en plus) au lieu d'être tranchée à coût nul. Le suivi
        de flux de données réel resterait le vrai correctif de fond.
        **[resserré côté noms de méthode la nuit du 2026-08-19, voir
        NIGHTLY_LOG.md]** `isDataAccess` comparait le nom d'appel à une liste
        de noms EXACTS (`findone`, `findbyid`...) : une convention ORM réelle
        mais absente de la liste (`findOneBy` en TypeORM, `findByIdAndUpdate`
        en Mongoose...) n'était pas reconnue comme un accès aux données et
        disparaissait complètement de l'analyse. Si une AUTRE requête de la
        même méthode était filtrée, le verdict décisif "sain" tombait quand
        même, à coût nul — la requête non reconnue n'avait jamais été
        examinée. Remplacé par une correspondance de PRÉFIXE sur le même jeu
        de verbes : un faux positif ne fait plus que renvoyer une route au LLM
        au lieu de la trancher gratuitement, jamais l'inverse. Toujours
        heuristique par construction (un verbe métier qui ne commence par
        aucun de ces préfixes reste invisible) ; le suivi de flux de données
        reste le vrai correctif de fond.
      - Un seul type de vuln (IDOR). La structure `prompt`/`scanner`/`node`
        est copiable telle quelle ; seuls la grille et les directives changent.
      - Pas encore de parcours automatique de toutes les routes ni de
        parallélisation : le node analyse une route à la fois (Phase 6).

- [x] **Phase 4 — Agrégateur** ✅ livrée
      Dédup, scoring de sévérité, routing par confidence_score.
      Livrable : agrégateur qui reçoit les findings de plusieurs nodes
      simulés et produit un payload trié pour le master.

      Fichiers : `src/aggregator/{aggregator,severity-rules,aggregator.test}.ts`,
      `scripts/measure-pipeline.ts`.
      Commandes : `npm test` (105/105), `npm run measure`.
      **Zéro appel LLM** — composant entièrement déterministe, vérifié par un
      test qui compare deux exécutions octet pour octet.

      ### ⚠️ MESURE EMPIRIQUE : 71,4 % vers Claude, pas 10-15 %

      `npm run measure` sur 7 routes de fixtures (gemini-2.5-flash-lite) :

      | Métrique | Valeur |
      |---|---|
      | routes analysées | 7 |
      | rejetées (< 0.4) | 2 |
      | envoyées à Claude | 5 |
      | **% des routes vers Claude** | **71,4 %** |
      | routes tranchées sans LLM | 2 |
      | coût | 5 appels, 3759 tokens entrée, 2296 sortie |

      La spec demande de noter ce dépassement comme signal de recalibrage du
      node (Phase 3). **Avant de recalibrer, il faut noter que ce chiffre n'est
      pas exploitable en l'état** : le corpus de fixtures a été écrit pour la
      Phase 3, où *chaque route est un cas de test de vulnérabilité*. Mesurer
      un taux de zone grise sur un corpus adversarial à ~85 % revient à mesurer
      le corpus, pas le node. Sur un vrai dépôt, la majorité des routes n'ont
      aucune surface IDOR et sortent au scanner déterministe, sans coût.

      **Deux vrais défauts de calibration sont quand même sortis de la mesure** :
      1. `GET /orders/public/:id` scoré **0.9** alors que la route est publique
         par conception. Le node ne tient pas compte du caractère public ; c'est
         l'agrégateur qui rattrape (sévérité HIGH -> MEDIUM). À traiter dans le
         prompt du node.
      2. `GET /orders/:id` **protégé par un `OwnershipGuard` résolu** scoré 0.6
         avec `missing_context`. Le corps du guard est pourtant fourni : le
         modèle réclame un contexte qu'il a déjà.

      **Action avant de conclure quoi que ce soit sur les 10-15 %** : construire
      un corpus représentatif (majorité de routes saines) et remesurer. Tant que
      ce n'est pas fait, le seuil de CLAUDE.md n'est ni validé ni invalidé.

      ### Écarts assumés par rapport à `PHASE_4_AGGREGATOR.md`

      1. **Fusion par TYPE, corrélation par emplacement.** La spec demande de
         « fusionner en un seul finding » deux vulnérabilités partageant route
         et ligne, même de natures différentes. C'est le défaut le plus grave
         de la phase : un finding fusionné n'a qu'un `confidence_score`, donc
         un SQLi à 0.93 et un XSS à 0.45 sur la même ligne se retrouvent avec
         un score unique — prendre le max promeut le XSS douteux en alerte
         directe, prendre le min enterre le SQLi quasi certain. Et un seul
         objet ne peut pas porter deux remédiations : l'utilisateur corrigerait
         un problème sur deux. On fusionne donc uniquement le MÊME type au même
         endroit (vraie duplication, et la concordance entre nodes devient un
         signal : `corroborated`), et on CORRÈLE les types différents dans un
         `LocationGroup` qui garde à chacun son score, sa sévérité et son
         routing. C'est bien « la liste des vulnérabilités concernées » de la
         spec, sans l'écrasement.
      2. **`http_method` dans la clé de fusion.** La spec dit « même route ».
         `GET /orders/:id` (lecture non autorisée) et `DELETE /orders/:id`
         (suppression non autorisée) auraient fusionné en une seule alerte.
      3. **Échelle de sévérité définie, et découplée de la confiance.** La spec
         parle de « +1 / -1 niveau » sans jamais dire quelle échelle ni quel
         niveau de base. Le piège aurait été de dériver la sévérité du
         `confidence_score` : ce sont deux axes indépendants — certitude vs
         impact. Un IDOR certain à 0.95 sur `/public/articles/:id` est moins
         urgent qu'un IDOR douteux à 0.45 sur `/admin/users/:id`. La sévérité
         part de la classe de vuln, les règles de route l'ajustent.
      4. **Liste d'exclusion élargie.** La spec ne couvre que `*.test.ts`,
         `*.spec.ts`, `mock/`, `fixtures/`. Manquaient `__tests__/`,
         `__mocks__/`, `__fixtures__/`, `e2e/`, `.stories.tsx` — au point que
         **les fixtures de ce dépôt n'auraient pas été filtrées** : VulnPipe se
         scannant lui-même aurait remonté ses propres cas de test. Chaque
         exclusion est tracée dans `stats.exclusions` : écarter par chemin est
         une décision de sécurité, jamais silencieuse.
      5. **Deux pourcentages au lieu d'un.** La spec ne demande que « % du
         volume total envoyé à Claude », calculé sur les findings. Or
         `CLAUDE.md` §2 parle de 10-15 % *du volume*, c'est-à-dire des routes
         scannées. Un node qui ne remonte que les cas suspects donnerait
         mécaniquement 100 % « de findings envoyés » tout en restant à 5 % du
         volume réel. `percent_of_routes_to_claude` est le chiffre comparable.
      6. **`plain_language_summary`** au niveau du run et de chaque groupe
         (`CLAUDE.md` §4), absent de la spec.
      7. **Tri déterministe** avec départage explicite (sévérité, puis
         confiance, puis route, puis verbe) — sans quoi deux runs identiques
         pouvaient rendre des ordres différents.

      ### Bugs trouvés par la mesure de bout en bout
      - **`gemini-2.5-flash-lite` refuse `thinkingConfig`** (`400 : Thinking
        level is not supported for this model`), que le client envoyait
        systématiquement. Corrigé par dégradation gracieuse : on tente, on
        observe le refus, on refait l'appel sans le champ et on s'en souvient —
        plutôt qu'une liste de modèles codée en dur, fausse au prochain modèle.
      - **Un scan entièrement en échec ressemblait à un scan propre.** Les 5
        routes en erreur étaient avalées par un `catch`, et le rapport
        affichait « 0 % vers Claude » avec un résumé rassurant. Le script
        compte désormais les échecs, invalide les pourcentages et sort en
        code 1.
      - **`/orders/public/:id` non reconnue comme publique** : la règle testait
        `startsWith('/public')` au lieu de découper les segments. Corrigé ;
        au passage `includes('/admin')` matchait `/badminton`.

      ### Limitations restantes
      - La ligne d'un finding vient du LLM et peut être approximative : la
        clé de fusion la place en dernier et tolère `null`. Deux findings du
        même type sur la même route dont l'un n'a pas de ligne sont fusionnés.
      - Listes de segments (admin, financier, public) codées en dur : à ajuster
        par projet, il n'y a pas encore de fichier de configuration.
      - Pas de persistance : le compteur est en mémoire, une comparaison entre
        deux commits n'est pas possible (hors scope MVP, cf. spec).

- [x] **Phase 5 — Master Claude + génération de rapport** ✅ livrée
      Appel API Claude sur le payload de l'Agrégateur, rédaction du
      rapport final en langage humain.
      Livrable : rapport lisible par un non-développeur sur un cas de test.

      Fichiers : `src/master/{claude-client,report-builder,master.test}.ts`,
      `scripts/report-demo.ts`.
      Commandes : `npm test` (128/128), `npm run report`.

      ### ⚠️ CORRECTION MAJEURE : L'ARBITRE NE VOYAIT PAS LE CODE

      La spec décrit l'appel comme « l'API Claude avec le payload de findings
      produit par l'Agrégateur », et justifie l'étape par « Claude peut avoir
      plus de contexte ou un meilleur raisonnement que le modèle local ».

      Or **le payload de l'Agrégateur ne contient aucun code** : scores,
      sévérités, résumés, statistiques. Un arbitre qui ne reçoit que le résumé
      du détecteur ne peut pas arbitrer — il peut seulement reformuler, et il
      lui est structurellement impossible d'infirmer un verdict faux.
      Ça invalide au passage le test que la spec demande elle-même (« si Claude
      rejette un verdict du node local ») : sur quelle base rejetterait-il ?

      `claude-client.ts` prend donc un `ContextProvider` (serveur MCP de la
      Phase 2) et récupère pour chaque finding le code réellement exécuté :
      handler, corps des guards, corps des méthodes appelées. Chaque verdict
      porte `evidence: 'code' | 'summary_only'` — sans provider l'arbitrage
      fonctionne toujours, mais personne ne prend une reformulation pour une
      vérification.

      ### Résultat réel — `npm run report` (chaîne complète)

      `ANTHROPIC_API_KEY` absente de `.env` : le master a tourné sur Gemini,
      **et le script le dit en clair** — un arbitrage rendu par un autre modèle
      que celui annoncé ne doit pas passer inaperçu. Défaut inchangé : Anthropic.

      | Étape | Résultat |
      |---|---|
      | routes analysées | 7 |
      | signalements vers le master | 2 |
      | verdicts | 1 `confirmed`, 1 `needs_human_review` |
      | preuve utilisée | `code` sur les deux |
      | coût | 2 appels détecteur + **1 appel arbitre** (1217 tokens entrée / 815 sortie) |

      Le `needs_human_review` est tombé exactement sur le cas prévu : route avec
      `@UseGuards(OwnershipGuard)` dont le code est introuvable. L'arbitre a
      écrit : *« son code est introuvable, rendant impossible de vérifier s'il
      implémente correctement le contrôle d'accès »*. Un binaire
      confirmed/rejected aurait forcé soit une confiance fabriquée, soit la
      disparition silencieuse d'une vulnérabilité peut-être réelle.

      ### Écarts assumés par rapport à `PHASE_5_MASTER_CLAUDE.md`

      1. **Verdict ternaire.** La spec n'offre que `"confirmed" | "rejected"`.
         Sur des cas justement ambigus, un binaire force l'arbitre à fabriquer
         une certitude ou à écarter à tort. `needs_human_review` garde le
         finding visible en le marquant non tranché, et le prompt système
         demande explicitement de le préférer au rejet.
      2. **Une panne n'efface jamais un finding.** La spec ne dit rien du cas
         où l'API échoue ou répond partiellement. Sans traitement, un rapport
         de sécurité amputé par une coupure réseau se lit « rien à signaler ».
         Les verdicts sont recollés par `finding_id` : tout finding sans
         verdict ressort dans `findings` avec le verdict local, marqué
         `evidence: 'not_arbitrated'`, et l'introduction le dit.
      3. **Contrainte « pas de patch » vérifiée en code.** La spec l'énonce
         comme consigne de prompt. Une instruction ne garantit rien : un modèle
         qui glisse un bloc ```` ```ts ```` dans `suggested_fix_direction`
         produit exactement ce que la contrainte veut éviter. `containsCodePatch`
         détecte blocs, diffs et hunks, et retire le contenu en le disant.
      4. **Correspondance des échelles rendue explicite.** L'Agrégateur travaille
         sur 5 niveaux (`info`…`critical`), le format de sortie n'en compte que
         2 (`critical` / `warning`), sans que la spec dise comment passer de
         l'un à l'autre. `toReportLevel` fixe la règle ; les 5 niveaux restent
         dans le rapport pour l'UI de la Phase 6.
      5. **Les rejets sont comptés, pas effacés.** La spec veut qu'un finding
         rejeté n'apparaisse pas dans le rapport visible — respecté. Mais il est
         conservé dans `dismissed` pour la calibration ET compté dans
         l'introduction : l'utilisateur doit savoir que l'outil a regardé puis
         écarté, sinon un rejet erroné est indétectable.
      6. **Couverture du scan dans l'introduction.** Absent de la spec : si des
         routes n'ont pas pu être analysées, le rapport écrit « ce scan est
         incomplet ». Une couverture partielle ne doit jamais se déduire d'une
         absence de findings.
      7. **Un seul appel API pour tout le lot** plutôt qu'un par finding : le
         contexte système est partagé, le coût divisé. Le risque de l'appel
         unique est neutralisé par le recollage par identifiant (point 2).
      8. **Tests déterministes + exécution réelle séparées**, comme en Phase 3.

      ### Bug trouvé en conditions réelles
      - **Palier gratuit Gemini : 20 requêtes/minute.** Un scan de 7 routes
        faisait échouer les dernières en `RESOURCE_EXHAUSTED`, alors que l'API
        indique elle-même le délai à attendre. Ajout de `withRetry` dans
        `shared/llm/types.ts` : suit le délai annoncé par l'API, ne réessaie
        jamais une erreur d'authentification.

      ### Limitations restantes
      - **L'arbitrage n'a jamais tourné sur Claude** faute de clé Anthropic.
        Le client Anthropic (SDK officiel) est écrit et typé, mais son
        comportement réel — refus des classificateurs, forme des sorties
        structurées — n'est pas vérifié en exécution. À faire avant de s'y fier.
      - Le `ContextProvider` passé à l'arbitre suppose que toutes les routes
        vivent dans le même index. Un scan multi-dépôts demandera d'associer
        chaque finding à son provider.
      - ~~Pas de cache d'arbitrage : deux scans successifs sur un code inchangé
        repaient l'appel master.~~ **Corrigé (2026-08-19)** —
        `src/master/arbitration-cache.ts`. La clé porte le CODE réellement
        montré à l'arbitre, pas l'identifiant de la route : sans ça, le cache
        resservirait « vulnérabilité confirmée » sur du code corrigé. Ne
        mémorise ni les findings non arbitrés, ni les verdicts rendus sans
        avoir vu le code — leur texte de preuve est constant, donc leur clé ne
        bougerait pas quand le code change.
        Reste ouvert : le cache vit en mémoire dans le serveur et ne survit pas
        à un redémarrage. La persistance dépend de la décision de stockage du
        point 5 de la file d'attente.

- [x] **Phase 6 — Orchestration + UI** ✅ livrée — **MVP COMPLET**
      File de messages, déclenchement sur webhook Git, interface qui affiche la
      pipeline en train de tourner + le rapport final en langage clair.

      Fichiers : `src/orchestration/{queue,step-events,pipeline,webhook,usage-tracker,orchestration.test}.ts`,
      `web/src/lib/step_translations.ts`,
      `web/src/components/{ScanTimeline,ReportView,UsagePanel,ProviderSwitcher,ui.test}.tsx`,
      `scripts/e2e-demo.ts`.
      Commandes : `npm test` (**176/176**), `npm run e2e`.

      ### Bout en bout réel — `npm run e2e`

      Webhook → file → indexeur → MCP → node IDOR → agrégateur → master →
      rapport → page HTML. Sur `openrouter/free`, **coût total : 0 $**.

      | | |
      |---|---|
      | adresses analysées | 4 |
      | appels détecteur | 2 (2 routes tranchées sans IA) |
      | appel arbitre | 1 |
      | coût | **0 $** (modèles gratuits) |
      | rendu vérifié | timeline ordonnée, détail replié, `IDOR` toujours accompagné de sa traduction |

      ### ⚠️ DEUX CONSTATS IMPORTANTS DE L'EXÉCUTION RÉELLE

      1. **`openrouter/free` change de modèle à chaque appel.** Un même scan a
         été servi par `nvidia-nemotron-3-super-120b`, `gemma-4-26b` puis
         `nemotron-nano-12b` — trois modèles de qualités très différentes.
         D'où l'ajout de `resolved_model` et `upstream_provider` dans le suivi :
         sans eux, impossible de savoir qui a produit quel verdict.
      2. **Un arbitre faible perd de vraies vulnérabilités.** Sur un premier
         run, le master (modèle gratuit) a **écarté la faille IDOR volontaire
         de `/orders/:id`** comme fausse alerte ; sur un second run il l'a
         confirmée. Le verdict final dépend donc du modèle tiré au sort. C'est
         la justification empirique de `CLAUDE.md` §2 (« Master : API Claude ») :
         **les modèles gratuits conviennent aux détecteurs, pas à l'arbitre.**
         La liste `dismissed` du rapport permet de voir ce qui a été écarté —
         c'est ce qui a rendu ce constat détectable.

      ### Fonctionnalités ajoutées (demandées, hors spec)

      - **Suivi de consommation** (`usage-tracker.ts` + `UsagePanel.tsx`) :
        tokens, coût et latence par étape et par modèle. Le tracker enveloppe
        n'importe quel `LlmClient`, les nodes n'ont rien à instrumenter. Un
        coût non communiqué est affiché comme inconnu, **jamais estimé** à
        partir d'une grille codée en dur qui serait fausse au premier
        changement de prix.
      - **Bascule de fournisseur à chaud** (`GET`/`POST /providers` +
        `ProviderSwitcher.tsx`) : détecteurs et arbitre se règlent séparément,
        sans redémarrer. Un fournisseur sans clé est affiché **désactivé avec
        la raison** plutôt que masqué.
      - **Support OpenRouter vérifié** : `OPEN_ROUTER_API_KEY` accepté en plus
        de `OPENROUTER_API_KEY`, défaut `openrouter/free`.

      ### `openai-compatible.ts` n'est plus « non vérifié »

      Le probe a tourné sur OpenRouter et l'en-tête du fichier porte désormais
      la sortie réelle. Trois faits : `json_schema` strict fonctionne et
      respecte l'`enum` ; **`json_object` seul ne suffit pas** (score renvoyé à
      `95` au lieu de `0.95`, même dérive qu'Ollama) ; OpenRouter expose le
      coût réel dans `usage.cost` et le fournisseur amont dans `provider`.

      ### Écarts assumés par rapport à `PHASE_6_ORCHESTRATION_UI.md`

      1. **La file est une interface, pas BullMQ en dur.** La décision
         `CLAUDE.md` §5 n'est pas rouverte, mais la coder en dur rend le MVP
         indémarrable : il faudrait un Redis en marche pour lancer le moindre
         scan, y compris le test de bout en bout que la phase exige. Deux mises
         en œuvre derrière `JobQueue` : `InMemoryQueue` (défaut, zéro
         dépendance) et `BullMqQueue` (dès que `REDIS_URL` est défini). `bullmq`
         reste **optionnel** — le specifier d'import est construit à l'exécution
         pour ne pas le rendre obligatoire à la compilation.
      2. **Statut `failed` sur les événements.** La spec ne prévoit que
         `running | done` : une étape qui plante resterait éternellement « en
         cours » ou sauterait à « terminé ». Même mode de défaillance qu'aux
         phases 4 et 5. Un `failed` n'est de plus jamais écrasé par un `done`
         ultérieur, sinon une étape partiellement en échec s'afficherait comme
         réussie.
      3. **`seq` et `run_id` sur chaque événement.** Sans numéro d'ordre, la
         timeline s'affiche en désordre dès que deux nodes publient en
         parallèle ; sans `run_id`, deux scans simultanés mélangent leurs
         événements.
      4. **`incremental_scan` implémenté.** La spec accepte le mode en
         paramètre du webhook sans jamais dire quoi en faire — alors que c'est
         la distinction centrale de `CLAUDE.md` §3, donc la tarification même du
         produit. Sélection par `git diff`, avec repli annoncé en `full_scan` si
         le diff n'est pas calculable : un incrémental silencieusement dégradé
         ferait exploser la facture sans prévenir.
      5. **Registre de nodes + `Promise.allSettled`.** La spec dit « (parallèle)
         Nodes de détection » au pluriel ; un seul existe. Le registre est en
         place, et `allSettled` garantit qu'un détecteur en échec n'annule pas
         les autres.
      6. **Termes techniques filtrés, pas seulement traduits.** La spec autorise
         le nom technique « accompagné de sa traduction ». Un terme **absent du
         glossaire** est remplacé par « Problème de sécurité » plutôt qu'affiché
         nu — sinon la règle ne tient que pour les termes qu'on a pensé à
         ajouter.
      7. **Tests d'UI réels plutôt que protocole manuel.** La spec autorise « un
         script manuel documenté ». Les trois points à vérifier à l'écran sont
         testés automatiquement dans un vrai DOM (22 tests), et `npm run e2e`
         produit en plus une page HTML consultable.

      ### Bugs trouvés en exécutant
      - **Disponibilité des fournisseurs mal détectée** : le SDK Anthropic se
        construit sans clé et n'échoue qu'à l'appel. L'interface annonçait donc
        « prêt » un fournisseur qui allait planter en plein scan. Détection
        déplacée dans `describeProviders`, fondée sur les clés.
      - **Texte illisible en thème sombre** : la page fixait la couleur du texte
        sans fixer le fond — titres noirs sur fond noir, constaté à l'écran.
        Corrigé avec les deux thèmes.
      - `environmentMatchGlobs` ne s'applique plus en Vitest 4 : l'environnement
        DOM est déclaré par fichier.

      ### Limitations restantes
      - **L'arbitre n'a toujours jamais tourné sur Claude** (pas de clé
        Anthropic). Vu le constat n°2 ci-dessus, c'est le premier point à
        traiter avant tout usage sérieux.
      - L'état des runs est en mémoire : un redémarrage du serveur perd
        l'historique.
      - ~~`incremental_scan` relie une route à un fichier modifié par le nom du
        contrôleur ; un service partagé modifié ne déclenche pas encore la
        réanalyse des routes qui en dépendent.~~ **Corrigé (nuit du
        2026-08-19)** : la sélection suit maintenant la carte d'injection du
        constructeur, transitivement (`routeDependencies` dans `pipeline.ts`).
        La condition précédente (`chemin.includes(nomDuContrôleur)`) ne
        pouvait jamais être vraie — `src/order.controller.ts` ne contient pas
        `OrderController` — donc seul le fichier du contrôleur lui-même
        déclenchait une réanalyse. Le commit qui retire le filtre `userId`
        d'un service affichait « rien à revérifier ».
      - Limites connues de cette sélection, à traiter plus tard :
        - Elle suit l'injection par constructeur (convention NestJS). Un
          service importé et instancié à la main, ou appelé via une fonction
          exportée, n'est pas relié à sa route.
        - Un fichier de code modifié que l'index ne rattache à aucune route
          fait retomber le scan en complet, avec un message qui l'explique.
          Direction volontairement prudente (jamais de faux négatif
          silencieux), mais sur un dépôt réel où beaucoup de fichiers ne sont
          liés à aucune route, l'incrémental retombera souvent en complet.
          À mesurer sur un vrai dépôt avant d'affiner.
        - La suppression d'un fichier apparaît dans le diff mais plus dans
          l'index : elle n'est donc rattachée à rien et déclenche le repli
          ci-dessus. C'est le bon comportement, mais par accident.

## Après le MVP (hors scope immédiat)
- Mode Full Scan (premier scan sans diff) avec chunking par route
- Shadow Pipeline (5% d'échantillonnage, bypass du node local pour mesurer
  le taux de faux négatifs)
- Ajout de nouveaux nodes (SSRF, Auth Failures, Crypto Failures...)
- Support multi-framework (Python/FastAPI, Go) via nouvelles queries
  S-expression, moteur d'indexation inchangé

---

## Application web (Vite + React) — livrée

Fichiers : `web/{index.html,vite.config.ts}`, `web/src/{main.tsx,App.tsx,styles.css}`,
`web/src/lib/{api.ts,useScan.ts,step_translations.ts}`,
`web/src/components/{ScanLauncher,ScanTimeline,PipelineExplainer,ReportView,UsagePanel,ProviderSwitcher}.tsx`,
`src/orchestration/server.ts`.

Commandes :
```
npm run dev     # API + interface (http://localhost:5173)
npm run serve   # API seule
npm run web     # interface seule
npm run build   # build de production
```

**Vérifié à l'écran** : scan complet lancé depuis l'interface sur la fixture
IDOR, timeline en direct avec barre de progression (3 sur 4), rapport final
avec les 2 failles, détail technique replié, panneau de consommation
(3 analyses, gratuit, 59 s). Build de production : 217 kB / 69 kB gzip.

### La pédagogie comme fonctionnalité première

La demande était d'expliquer chaque étape à un public non technique. Une
timeline dit *ce qui* se passe, pas *pourquoi* — et une progression qu'on ne
comprend pas n'inspire aucune confiance dans le verdict final. Chaque étape a
donc reçu deux champs dans `step_translations.ts` :

- `why` : à quoi sert l'étape, sans vocabulaire technique ;
- `analogy` : une comparaison du quotidien (« comme faire le tour d'une maison
  pour compter les portes avant de vérifier les serrures »).

Ils alimentent `PipelineExplainer`, affiché en entier avant le scan et replié
sous chaque étape pendant (« À quoi ça sert ? »). Un test vérifie qu'aucun des
mots `index`, `MCP`, `LLM`, `API`, `node`, `payload`, `AST`, `JSON` n'apparaît
dans ces explications. Le formulaire suit la même règle : on demande « Où se
trouve ton projet ? » et « Quelle étendue ? », jamais `repo_path` ni
`full_scan`.

### Bug trouvé en câblant l'app

**Les composants `.tsx` n'avaient jamais été typecheckés** : le `tsconfig.json`
n'incluait que `src/**/*.ts`. `npx tsc --noEmit` passait au vert en ignorant
tout le dossier `web/`. Corrigé — et la première exécution a immédiatement
révélé une erreur d'interop sur l'import de `@testing-library/user-event`.

### Limitations de l'app web
- Un seul scan à la fois affiché : pas d'historique ni de comparaison entre
  deux analyses.
- Le chemin du projet est saisi à la main (pas de sélecteur de dossier :
  impossible depuis un navigateur sans dialogue natif).
- Pas d'authentification : le service est prévu pour un usage local, comme
  posé dans `CLAUDE.md` §6.

---

## Itération UI — présentation, réglages, jeu d'icônes

Trois demandes traitées ensemble, toutes côté interface (aucune règle de
détection touchée).

### 1. Plus aucun emoji à l'écran

Les emoji (`📥 ✅ 🔴 🟠 📁 💡`…) sont remplacés par un jeu de tracés SVG
maison : `web/src/components/Icon.tsx`, 33 icônes monochromes en `currentColor`.

Motif : un emoji est dessiné par le système d'exploitation (plat sur Windows,
bombé sur macOS), il importe ses propres couleurs — ce qui contredit la règle
n°2 de `styles.css`, « le rouge et l'orange ne servent qu'aux verdicts » — et
il est annoncé n'importe comment par un lecteur d'écran. Le nom d'icône est
désormais une valeur typée (`IconName`) portée par le catalogue i18n : une
icône inexistante ne compile pas.

Par défaut une icône est décorative (`aria-hidden`) ; seule la pastille d'état
d'une étape, qui porte l'information seule, est annoncée. Les scripts CLI
(`server.ts`, `e2e-demo.ts`, `bench-idor.ts`) affichent `[ok] / [--]` au lieu
de `✅ / ❌`.

Test : `landing.test.tsx` rend la timeline, le suivi en direct et la
présentation dans les deux langues et vérifie qu'aucun caractère des plages
emoji Unicode n'apparaît — la régression serait attrapée même avec un autre
symbole que ceux retirés.

### 2. Page de présentation

Nouvel onglet **Présentation**, ouvert par défaut :
`web/src/components/LandingPage.tsx` + `Diagrams.tsx`.

Neuf sections : promesse, le problème, **schéma d'architecture**, les sept
étapes, **les trois zones de confiance**, **l'entonnoir de coût**, couverture
réelle des détecteurs, engagements, FAQ, rappel de l'appel à l'action.

Les trois figures sont dessinées en SVG/HTML, pas exportées en image : elles
suivent la langue, la palette, et restent lisibles par un lecteur d'écran. Le
schéma d'architecture isole visuellement l'unique étape payante — c'est la
question que se pose en premier quelqu'un qui hésite à essayer.

Les sept étapes ne sont **pas** réécrites : elles viennent du même catalogue
que la timeline affichée pendant un scan (un test le vérifie). Une promesse et
un compte rendu qui divergent ne sont plus vérifiables. La couverture est
annoncée telle quelle : 1 détecteur disponible, 3 prévus.

### 3. Page de réglages étoffée

`web/src/components/SettingsPage.tsx`, cinq blocs, chacun étiqueté selon sa
portée — **appliqué sur le serveur** ou **gardé dans ce navigateur**. Sans
cette distinction, quelqu'un croit régler son confort de lecture et modifie ce
que la pipeline facture.

Serveur (nouvelles routes `GET/POST /settings`) :
- contournement de l'arbitrage pour les findings > 0.7 (option « bypass » de
  `CLAUDE.md` §3, jusqu'ici seulement présente dans le code de l'agrégateur et
  inatteignable depuis l'interface) ;
- seuils de confiance affichés **d'après la réponse du serveur**, jamais
  recopiés dans l'UI.

Navigateur (`web/src/lib/preferences.ts`) :
- cible et étendue par défaut, mémorisation de la dernière cible ;
- seuil d'acceptation automatique d'un devis (0 par défaut = toujours
  demander ; un devis non chiffrable n'est jamais accepté tout seul) ;
- détail technique et explications d'étape ouverts d'emblée ;
- langue, état du service, moteurs disponibles avec la raison d'indisponibilité,
  remise à zéro des préférences.

Défauts corrigés au passage, invisibles tant que la page ne contenait qu'un
bloc : `select` et `input[type=number]` étaient laissés au rendu natif (menus
blancs sur fond charbon), et les libellés du sélecteur de moteur se collaient à
leur explication faute de styles.

**Attention** : `npm run dev` doit être relancé pour servir `/settings` — le
proxy Vite a été complété, mais l'API ne connaît la route qu'après redémarrage.

Tests : 283 verts (`npm test`), dont 20 nouveaux sur les icônes, la
présentation, les préférences et les réglages, et 4 sur les nouvelles routes
serveur. `npx tsc --noEmit` propre, build de production 293 kB / 91 kB gzip.

---

## Améliorations d'expérience — file d'attente

Liste établie le 2026-08-19, à partir d'un état des lieux de l'interface et
d'une revue de ce que font les autres outils (Semgrep, Snyk, tableaux de bord
AppSec). Ordonnée par rapport valeur/effort, pas par ordre d'envie.

Le fil conducteur : le produit sait **trouver** une faille et l'**expliquer**,
mais il ne sait pas encore aider à la **corriger**, ni montrer qu'on progresse.

### Niveau 1 — rendre une faille actionnable

Une faille affiche aujourd'hui « `order.service.ts` (ligne 3) » et s'arrête là.
On annonce un problème ligne 3 à quelqu'un qui ne sait pas lire du code.

- [x] **1. Bouton « copier le prompt de correction »** ✅ livré (2026-08-19)
      Met dans le presse-papier un texte prêt à coller dans un assistant IA :
      code fautif, explication, direction de correction, garde-fous.
      Justification : la cible du produit ne corrigera pas à la main — elle
      redemandera à une IA. Autant lui donner le bon prompt. Coût : nul,
      entièrement déterministe.
- [x] **2. Afficher l'extrait de code fautif** ✅ livré (2026-08-19)
      Ligne en cause surlignée, quelques lignes de contexte. Voir le code fait
      davantage pour la confiance dans le verdict qu'un numéro de ligne.
- [x] **3. « Ouvrir dans mon éditeur »** ✅ livré (2026-08-19)
      Lien `vscode://` / `cursor://` vers le fichier à la bonne ligne.
- [x] **4. Exporter et partager le rapport** ✅ livré (2026-08-19)
      Copier en Markdown, télécharger. Rien ne sortait de l'écran : impossible
      de garder une trace ou de montrer le rapport à quelqu'un.
      Trois points tenus dans `web/src/lib/report-markdown.ts` : le langage
      simple reste AVANT le jargon, les alertes écartées restent comptées, et
      aucun chemin absolu ne fuit dans un document fait pour être partagé
      (`source_root` est délibérément absent).

### Niveau 2 — passer du scan ponctuel au suivi

- [ ] **5. Historique et comparaison entre deux scans**
      Nouveau / corrigé / toujours présent, avec la tendance. C'est le pattern
      standard des tableaux de bord sécurité. Sans lui, chaque scan repart de
      zéro et l'utilisateur ne voit jamais qu'il progresse — c'est aussi ce qui
      donne son sens au mode incrémental.
      **Prérequis** : la persistance (l'état des runs est en mémoire, cf.
      limitations de la Phase 6). **Décision à prendre avant de coder** : format
      de stockage. `CLAUDE.md` §5 dit « JSON structuré en V1 ».
- [x] **6. Statut par faille : corrigé / risque accepté / faux positif** ✅ livré (2026-08-19)
      `web/src/lib/finding-status.ts`. Justification EXIGÉE pour écarter (risque
      accepté, fausse alerte), pas pour « corrigé » — le scan suivant le vérifie
      tout seul.
      Le piège annoncé est tenu : `fixRate()` exclut les points écartés des DEUX
      côtés de la fraction, écarter ne fait donc jamais monter le taux ; une
      faille écartée est estompée, jamais retirée de l'écran.
      Ajout non prévu : une faille marquée « corrigée » que le scan détecte
      encore est signalée. L'outil regarde le code, la case coche une intention ;
      quand les deux se contredisent, c'est la case qui a tort.
      **Limite assumée** : les statuts vivent dans le navigateur
      (`localStorage`), pas sur le serveur — ils ne suivent pas d'une machine à
      l'autre. Ce choix évite d'engager la décision de stockage du point 5.
- [ ] **7. Cache d'arbitrage** (déjà listé en limitation de la Phase 5)
      Techniquement une optimisation, vécue comme une fonctionnalité :
      relancer un scan sur du code inchangé devient instantané et gratuit.

### Niveau 3 — aller là où la personne travaille

- [ ] **8. GitHub Action + hook pre-commit**
      Les résultats doivent arriver dans les outils déjà utilisés plutôt que
      dans un onglet à ouvrir. Le webhook existe : l'essentiel est l'emballage.
- [ ] **9. Commentaire automatique sur la pull request** — suite logique du 8.

### Niveau 4 — confiance et agrément

- [ ] **10. Travailler l'état « aucune faille trouvée »**
      Un rapport vide ressemble à une panne. Le projet a pour règle « une panne
      ne doit jamais ressembler à un succès » ; la réciproque est vraie aussi.
      Il faut dire CE QUI A ÉTÉ VÉRIFIÉ, pas afficher du vide.
- [ ] **11. Progression dans le temps** — failles ouvertes semaine après
      semaine. À ne brancher qu'après le point 5, sur des données réelles.

### Écarté pour l'instant

- Score de sécurité global sur 100 : un chiffre unique invite à optimiser le
  chiffre. Le point 11, adossé à des failles réelles, dit la même chose sans
  inventer une métrique.
## Authentification par abonnement Claude (Pro / Max) — livrée le 2026-08-19

`VULNPIPE_LLM_PROVIDER=claude-subscription` fait tourner VulnPipe sur
l'abonnement Claude que la personne paie déjà, au lieu d'une clé API facturée
à l'appel. Fichier : `src/nodes/shared/llm/claude-subscription.ts`.

### Pourquoi c'est légitime, et où est la limite

Le chemin passe par le **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`),
le client officiel d'Anthropic, qui s'authentifie via la session Claude Code de
l'utilisateur. La documentation Anthropic dit explicitement que l'usage du
Claude Agent SDK, de `claude -p` et **des applications tierces** tire sur les
limites d'usage de l'abonnement. Ce n'est donc pas un contournement.

**La limite** : ça vaut pour un usage local et mono-utilisateur — le cadre posé
par `CLAUDE.md` §6. Un service hébergé qui consommerait l'abonnement d'un tiers,
ou qui collecterait des jetons OAuth d'utilisateurs, sortirait des conditions
d'utilisation. VulnPipe ne demande et ne stocke aucun jeton : il constate
seulement que Claude Code est installé sur la machine.

### Ce que ça coûte réellement (mesuré, pas supposé)

Sondage du 2026-08-19 (`@anthropic-ai/claude-agent-sdk` 0.3.235) : un appel
trivial (8 jetons de sortie) transporte ~26 000 jetons de contexte — le harnais
de Claude Code lui-même — même avec `allowedTools: []`. Ce volume est prélevé
sur les limites de l'abonnement.

**Conséquence pratique** : brancher ce fournisseur sur l'**arbitre** (un appel
par scan, `CLAUDE.md` §2), pas sur les nodes de détection (un appel par route).

### Le piège traité en code

L'ordre de résolution des identifiants met `ANTHROPIC_API_KEY` **avant** la
session Claude Code. Quelqu'un qui a exporté une clé pour un autre projet
paierait à l'appel en croyant consommer son abonnement. Le champ `apiKeySource`
du message `system/init` dit qui a gagné : il est lu, et l'écart est annoncé.
`describeProviders()` refuse même d'annoncer ce fournisseur comme disponible
quand une clé API est présente — il marcherait, mais il ne ferait pas ce que
son nom promet.

### Limites restantes
- Le SDK ne propose pas de sortie structurée (pas d'équivalent
  `output_config.format`) : le JSON est obtenu par consigne puis extrait du
  texte. Toléré : bloc ``` autour, phrase avant/après. Au-delà, échec franc.
- `total_cost_usd` renvoyé par le SDK est l'**équivalent au tarif API**, pas une
  somme débitée. Il est remonté comme tel (`cost_usd: 0` + mention explicite) ;
  l'afficher comme une dépense serait faux sur un abonnement.
- Le surcoût de ~26 000 jetons par appel n'est pas réductible depuis l'API
  publique du SDK. À re-mesurer si une option de harnais minimal apparaît.
- Non testé sur un scan complet réel : seuls des sondages unitaires ont tourné.


---

## Choix du moteur, du modèle et de la profondeur — livré le 2026-08-19

### Trois choix explicites, par rôle (détection / arbitrage)

1. **API Claude ou abonnement** — deux fournisseurs distincts et nommés :
   `anthropic` (clé API, facturé à l'appel) et `claude-subscription` (ton
   abonnement Pro/Max via Claude Code). Le second n'a besoin d'aucune clé.
2. **Le modèle** — champ libre avec suggestions, ordonnées **du moins gourmand
   en jetons au plus capable**. L'ordre porte l'information.
3. **La profondeur de réflexion** (`effort`) — `low` → `max`, ou « défaut du
   modèle » pour ne rien forcer. Vérifié comme supporté des deux côtés :
   `output_config.effort` sur l'API, `options.effort` sur le SDK (types du SDK
   0.3.235 lus, pas supposés).

Un niveau inconnu envoyé à `POST /providers` est **refusé** (400) et non ignoré :
posé explicitement par la personne, l'avaler en silence lui ferait croire à un
réglage appliqué. Un niveau inconnu dans `.env` retombe en revanche sur le
défaut du modèle sans faire échouer le scan — une faute de frappe dans un
réglage de confort ne doit pas coûter une analyse.

### Vocabulaire : où vont les jetons, pas « gratuit vs payant »

Le vocabulaire « modèle gratuit / modèle payant » a été retiré de toute
l'interface et des messages serveur. Il décrivait l'effet sur la carte
bancaire, pas la mécanique — et il devenait carrément faux sur un abonnement,
où rien n'est débité à l'appel alors que des jetons sont bien consommés.

Le vocabulaire retenu distingue trois choses différentes que « gratuit »
confondait :

| Avant | Maintenant | Ce que ça dit vraiment |
|---|---|---|
| « réglé gratuitement » | « tranché sans IA » | zéro jeton, aucun modèle appelé |
| « modèle gratuit » | « modèle peu coûteux / léger » | des jetons, mais peu |
| « modèle payant » | « modèle le plus capable » | là où part l'essentiel des jetons |

### Limites restantes
- Le palier de puissance d'un modèle est porté par l'ORDRE de la liste de
  suggestions, pas par une étiquette par modèle. Une liste tenue à la main
  vieillit ; un jour il faudra la tirer de l'API des modèles.
- L'effort n'est pas ajusté automatiquement selon le rôle. On pourrait
  proposer un défaut plus bas pour la détection (beaucoup d'appels) que pour
  l'arbitrage (un seul) — non fait, ce serait un choix à la place de la personne.
- `max_tokens` n'est pas exposé : un effort élevé sans marge de sortie peut
  tronquer. À surveiller si quelqu'un remonte une réponse coupée.
