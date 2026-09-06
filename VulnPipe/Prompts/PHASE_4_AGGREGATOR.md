# Prompt — Phase 4 : Agrégateur

Copie ce prompt dans une nouvelle session Claude Code. Prérequis : Phase 3
terminée (au moins le node IDOR).

---

## Contexte

Lis `CLAUDE.md`. Cette phase construit l'**Agrégateur** : un composant
**entièrement déterministe, sans aucun appel LLM**, qui reçoit les
findings des nodes de détection et décide quoi envoyer au master Claude.

## Objectif de cette phase

1. Recevoir une liste de findings (format défini en Phase 3, un objet par
   vulnérabilité détectée, chacun avec `confidence_score` et `reason`)
2. **Déduplication** : si deux findings pointent la même route + la même
   ligne de code (même si détectés par des nodes différents), fusionner en
   un seul finding avec la liste des vulnérabilités concernées
3. **Scoring de sévérité (heuristique)** : appliquer des règles simples de
   priorisation —
   - route contenant `/admin`, `/internal`, ou manipulant des données
     financières/personnelles → sévérité +1 niveau
   - route sous `/public/*` ou explicitement marquée publique dans les
     décorateurs → sévérité -1 niveau
4. **Filtrage des faux positifs évidents** : exclure automatiquement tout
   finding dont le fichier source matche `*.test.ts`, `*.spec.ts`, ou est
   dans un dossier `mock/` ou `fixtures/`
5. **Routing par confidence_score** (voir grille dans `CLAUDE.md` section 3) :
   - `< 0.4` → rejeté, ne va nulle part, juste loggé pour stats
   - `0.4 - 0.7` → va dans le payload envoyé au master Claude
   - `> 0.7` → va dans le payload ET peut être marqué comme "alerte directe"
     (configurable : bypass Claude ou non, selon un paramètre)
6. Produire un **payload final trié par sévérité** prêt à être envoyé au
   master (Phase 5)

## Contrainte de mesure

Ajoute un compteur simple (juste un objet en mémoire pour ce MVP, pas
besoin de vraie base de données) qui trace, pour chaque run :
- nombre total de findings reçus
- nombre rejetés (score < 0.4)
- nombre envoyés à Claude (zone grise)
- nombre en alerte directe (score > 0.7)
- % du volume total effectivement envoyé à Claude

Ce compteur sert à vérifier empiriquement que la "zone grise" reste bien
dans la fourchette 10-15% mentionnée dans `CLAUDE.md` — s'il en sort très
au-dessus dans les tests, note-le dans `ROADMAP.md`, ce sera un signal
que le prompt du node local (Phase 3) doit être recalibré.

## Cas de test à valider

Construis un jeu de 10 findings simulés (pas besoin de vrais appels LLM
ici, mocke des objets findings avec des scores variés) qui couvre :
- 2 findings dupliqués sur la même route/ligne, détectés par 2 nodes
  différents → doivent fusionner en 1
- 1 finding sur un fichier `order.test.ts` → doit être exclu
- 1 finding sur une route `/admin/users/:id` avec score 0.6 → vérifie que
  la sévérité est bien remontée
- Un mix de scores couvrant les 3 zones, vérifie le routing correct

## Livrable attendu

- `src/aggregator/aggregator.ts`
- `src/aggregator/severity-rules.ts` — les règles heuristiques, dans un
  fichier séparé pour pouvoir les ajuster facilement sans toucher à la
  logique de routing
- `src/aggregator/aggregator.test.ts` — le cas de test ci-dessus, exécuté réellement
- Mise à jour de `ROADMAP.md`
