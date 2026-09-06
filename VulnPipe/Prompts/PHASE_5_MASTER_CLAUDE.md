# Prompt — Phase 5 : Master Claude + génération du rapport

Copie ce prompt dans une nouvelle session Claude Code. Prérequis : Phase 4 terminée.

---

## Contexte

Lis `CLAUDE.md`. Cette phase branche l'API Anthropic comme **arbitre final**
sur le payload produit par l'Agrégateur (Phase 4), et génère le rapport
final destiné à l'utilisateur.

## Objectif de cette phase

1. Un client qui appelle l'API Claude (utilise le SDK Anthropic officiel,
   ne réinvente pas les appels HTTP à la main) avec le payload de findings
   "zone grise" et "alerte directe" produit par l'Agrégateur.
2. Le rôle de Claude dans ce prompt système :
   - Valider ou rejeter chaque verdict du node local, en expliquant
     pourquoi (Claude peut avoir plus de contexte ou un meilleur
     raisonnement que le modèle local sur les cas ambigus)
   - Pour chaque finding validé, rédiger DEUX choses distinctes :
     a. Un résumé technique classique (pour un développeur qui veut le
        détail : ligne, snippet, catégorie OWASP)
     b. Une explication en français simple destinée à quelqu'un qui ne
        code pas — quel est le risque concret, dans quel scénario un
        attaquant l'exploiterait, et quelle est la correction en une
        phrase (pas un patch complet, juste l'idée : "il faut vérifier que
        l'utilisateur est bien propriétaire de la ressource avant de la
        renvoyer")
3. Produire un rapport final structuré, groupé par sévérité, dans un
   format qui pourra être consommé tel quel par l'UI de la Phase 6.

## Format de sortie attendu du rapport

```json
{
  "scan_summary": {
    "total_findings": 3,
    "critical": 1,
    "warning": 2,
    "plain_language_intro": "On a trouvé 3 points d'attention dans ton code, dont 1 qui mérite une correction rapide."
  },
  "findings": [
    {
      "severity": "critical",
      "vulnerability": "IDOR",
      "route": "/orders/:id",
      "claude_verdict": "confirmed" | "rejected",
      "claude_reasoning": "...",
      "technical_summary": "...",
      "plain_language_summary": "...",
      "suggested_fix_direction": "..."
    }
  ]
}
```

## Contrainte

Ne fais jamais écrire à Claude un patch de code complet et prêt à
appliquer automatiquement dans cette phase — le but du MVP est
d'expliquer et d'orienter, pas de proposer un merge automatique
(risque de patch cassé ou incomplet appliqué en aveugle). Cette
fonctionnalité pourra être ajoutée plus tard, explicitement, comme
feature séparée avec revue humaine obligatoire.

## Cas de test à valider

Utilise le payload produit par les tests de la Phase 4 (les 10 findings
simulés). Vérifie que :
- les findings avec score > 0.7 ET validés par Claude apparaissent en
  `"critical"` ou `"warning"` selon la sévérité de l'Agrégateur
- chaque finding a bien les deux résumés (technique + langage simple)
- si Claude rejette un verdict du node local (`claude_verdict: "rejected"`),
  le finding n'apparaît PAS dans le rapport final visible, mais reste
  loggé pour les statistiques de calibration (utile plus tard pour ajuster
  les prompts des nodes locaux)

## Livrable attendu

- `src/master/claude-client.ts`
- `src/master/report-builder.ts`
- `src/master/master.test.ts` — le cas de test ci-dessus
- Mise à jour de `ROADMAP.md`
