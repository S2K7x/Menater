# Prompt — Phase 3 : Node de détection IDOR (modèle de référence pour les autres nodes)

Copie ce prompt dans une nouvelle session Claude Code. Prérequis : Phase 1
et Phase 2 terminées et cochées dans `ROADMAP.md`.

---

## Contexte

Lis `CLAUDE.md` à la racine. Cette phase construit le premier **node de
détection local** : IDOR (Insecure Direct Object Reference). Ce node sert
de gabarit — les nodes suivants (XSS, SQLi, Security Misconfiguration)
réutiliseront la même structure.

## Objectif de cette phase

1. Un client MCP qui appelle `get_context(route, depth)` sur le serveur de
   la Phase 2 pour récupérer le contexte d'une route donnée.
2. Un appel à un LLM local via **Ollama** (modèle par défaut : à choisir
   parmi les modèles orientés code disponibles localement — démarrer avec
   un modèle 8B, ex. famille Llama ou Qwen-Coder, le nom exact dépend de ce
   qui est installé sur la machine ; vérifie avec `ollama list` avant de
   coder en dur un nom de modèle).
3. Le prompt envoyé au LLM local doit suivre EXACTEMENT cette structure
   (ne pas la simplifier, chaque partie a un rôle précis dans la
   calibration du score) :

```
Vous êtes un agent de sécurité statique (SAST) spécialisé dans la
détection des failles IDOR (Insecure Direct Object Reference).

### CONTEXTE DU CODE À ANALYSER
[ROUTE ET HANDLER]
{code_du_handler}
[CALL GRAPH RÉSOLU - NIVEAU 1 À {depth}]
{code_des_fonctions_appelees}

### DIRECTIVES D'ANALYSE (Chain-of-Thought obligatoire avant le score)
1. Identification de la source : quelle variable représente l'identifiant
   de la ressource demandée ?
2. Identification du contexte utilisateur : où est récupérée l'identité de
   l'utilisateur qui fait la requête ?
3. Analyse du flux de contrôle : le code croise-t-il explicitement
   l'identifiant de la ressource ET l'identifiant de l'utilisateur ?

### GRILLE DE CALIBRATION DU SCORE
- 0.0 à 0.3 (Sain) : la requête croise explicitement id + userId, ou la
  route est publique par design.
- 0.4 à 0.7 (Zone grise) : une fonction/décorateur d'autorisation est
  présent mais son code n'est pas fourni dans le contexte (→ reason:
  "missing_context"), OU la logique métier est ambiguë même avec tout le
  contexte disponible (→ reason: "ambiguous_logic").
- 0.8 à 1.0 (IDOR probable) : aucun croisement id/userId, aucune fonction
  d'autorisation détectée.

### FORMAT DE SORTIE — JSON STRICT, rien avant ni après
{
  "analysis": {
    "resource_identifier": "...",
    "user_context": "...",
    "step_by_step_reasoning": "..."
  },
  "findings": [{ "vulnerability": "IDOR", "line": ..., "proof_snippet": "..." }],
  "confidence_score": 0.00,
  "reason": null | "missing_context" | "ambiguous_logic",
  "plain_language_summary": "Explication en français simple, pour un non-développeur : quel est le risque concret, qu'est-ce qu'un attaquant pourrait faire."
}
```

Le champ `plain_language_summary` est OBLIGATOIRE sur chaque finding, avec
`confidence_score >= 0.4` — voir `CLAUDE.md` section 4 (exigence
d'explicabilité). N'écris jamais de jargon SAST dedans ("taint analysis",
"sink", "sanitization") — écris comme si tu expliquais à quelqu'un qui n'a
jamais codé ce qui pourrait lui arriver.

## Comportement attendu selon `reason`

- Si `reason === "missing_context"` et que la profondeur actuelle est
  inférieure à 3 : le node doit automatiquement rappeler
  `get_context(route, depth+1)` UNE SEULE FOIS avant de considérer le
  verdict comme final (évite les boucles infinies — un seul niveau de
  retry).
- Si `reason === "ambiguous_logic"` : pas de retry, le verdict part tel
  quel vers l'Agrégateur (Phase 4).

## Cas de test à valider (3 cas obligatoires, résultats réellement vérifiés, pas supposés)

1. **Cas vulnérable évident** : `findById(id)` sans filtre userId, aucun
   guard → doit produire `confidence_score >= 0.8`
2. **Cas sain** : `db.find({ id, userId: req.user.id })` → doit produire
   `confidence_score <= 0.3`
3. **Cas zone grise** : un `@UseGuards(OwnershipGuard)` présent mais dont
   le code n'est pas résolu par le MCP (classe non trouvée) → doit
   produire `confidence_score` entre 0.4 et 0.7 ET `reason:
   "missing_context"`

Exécute réellement ces 3 cas contre le LLM local installé et documente le
score obtenu dans le test — si le modèle dérive hors de la plage attendue,
ajuste le prompt (ajoute les 2 exemples few-shot mentionnés dans
`CLAUDE.md` comme filet de sécurité) plutôt que de forcer le résultat.

## Livrable attendu

- `src/nodes/idor/prompt.ts` — le template de prompt
- `src/nodes/idor/node.ts` — la logique du node (appel MCP + appel Ollama + parsing JSON + logique de retry)
- `src/nodes/idor/node.test.ts` — les 3 cas de test, exécutés réellement, scores documentés en commentaire
- Mise à jour de `ROADMAP.md`

## Note pour les phases suivantes (XSS, SQLi...)

Ce node sert de gabarit. La structure `prompt.ts` / `node.ts` / `node.test.ts`
doit être copiable telle quelle pour les prochaines vulnérabilités — seule
la grille de calibration et les directives d'analyse changent par type de
vuln. Ne code pas de logique spécifique à IDOR dans le client MCP ou le
wrapper Ollama : garde-les génériques dans un dossier `src/nodes/shared/`.
