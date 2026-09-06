# Prompt — Phase 6 : Orchestration + UI ("Vibe Coder Mode")

Copie ce prompt dans une nouvelle session Claude Code. Prérequis : Phases 1 à 5 terminées.

---

## Contexte

Lis `CLAUDE.md`. C'est la dernière phase du MVP : elle relie tous les
composants précédents (Indexeur → MCP → Nodes → Agrégateur → Master) via
une file de messages, et construit l'interface qui affiche tout ça à
l'utilisateur final — quelqu'un qui **n'a pas besoin de savoir coder pour
comprendre ce que la pipeline a trouvé**.

## Objectif de cette phase

### Partie A — Orchestration

1. Mettre en place une file de messages légère (BullMQ + Redis).
2. Un endpoint webhook qui reçoit un événement Git (simulé pour le MVP —
   pas besoin de vraie intégration GitHub/GitLab tout de suite, un simple
   endpoint HTTP qui accepte `{ repo_path, commit_sha, mode:
   "full_scan" | "incremental_scan" }` suffit).
3. La chaîne de jobs : Indexeur → (parallèle) Nodes de détection →
   Agrégateur → Master Claude → stockage du rapport final.
4. Chaque étape de la chaîne doit publier un événement de progression
   (ex: `{ step: "indexing", status: "running" | "done", plain_language: "Analyse de la structure du code en cours..." }`)
   — c'est ce que l'UI va afficher en temps réel.

### Partie B — UI ("Vibe Coder Mode")

Une interface simple (React) qui affiche, dans l'ordre :

1. **Pendant le scan** : une timeline en langage humain de ce qui se passe
   — PAS "Node IDOR: running", mais "On vérifie que personne ne peut voir
   les données des autres utilisateurs..." Chaque étape technique de la
   pipeline (voir `CLAUDE.md` section 2) doit avoir une traduction en
   langage courant, définie dans une table de correspondance
   `step_translations.ts` (facile à enrichir plus tard).

2. **Le rapport final** : utilise le format produit en Phase 5. Pour
   chaque finding, affiche PAR DÉFAUT uniquement le `plain_language_summary`
   et la sévérité (badge couleur : rouge/critique, orange/warning), avec
   un bouton "Voir le détail technique" qui déplie `technical_summary` et
   `suggested_fix_direction` — repliable, pas imposé à l'utilisateur non-tech.

3. **Un résumé en haut de page** basé sur `scan_summary.plain_language_intro`,
   qui donne le verdict global en une phrase avant même de scroller dans
   le détail.

## Contrainte de design (important)

Ne construis JAMAIS un écran qui affiche du JSON brut, un stack trace, ou
un terme SAST non expliqué (CVE, OWASP, taint, sink...) sans une
info-bulle ou une reformulation. Le persona cible ne sait pas ce qu'est un
IDOR — le nom technique peut apparaître, mais toujours accompagné de sa
traduction en langage simple juste à côté, jamais seul.

## Cas de test à valider

Simule un scan complet de bout en bout sur la fixture utilisée dans les
phases précédentes (`OrderController` avec la faille IDOR volontaire sur
`/orders/:id`). Vérifie que :
1. La timeline de progression s'affiche dans le bon ordre
2. Le rapport final affiche bien le finding IDOR avec son résumé en
   langage simple, sans jargon non expliqué
3. Le détail technique reste accessible mais replié par défaut

## Livrable attendu

- `src/orchestration/queue.ts`, `src/orchestration/webhook.ts`
- `src/orchestration/step-events.ts`
- `web/src/components/ScanTimeline.tsx`
- `web/src/components/ReportView.tsx`
- `web/src/lib/step_translations.ts`
- Un test end-to-end (peut être un script manuel documenté si le vrai E2E
  est trop lourd pour ce MVP — mais documente précisément comment le
  relancer et ce qu'on doit observer à l'écran)
- Mise à jour finale de `ROADMAP.md`
