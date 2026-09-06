# Prompt — Phase 2 : Serveur MCP

Copie ce prompt dans une nouvelle session Claude Code. Prérequis : la
Phase 1 (`src/indexer/`) doit être terminée et son test doit passer.

---

## Contexte

Lis `CLAUDE.md` à la racine pour l'architecture globale, et `ROADMAP.md`
pour vérifier que la Phase 1 est bien cochée avant de commencer. Cette
phase construit le pont entre l'Indexeur (Phase 1) et les futurs nodes de
détection (Phase 3) : un **serveur MCP**.

## Objectif de cette phase

Exposer l'index produit par `src/indexer/` via le protocole MCP (Model
Context Protocol), avec un tool principal :

```
get_context(route: string, depth: number = 2) → {
  endpoint: <objet endpoint tel que produit par l'Indexeur>,
  resolved_calls: [
    {
      call: "findById",
      injected_type: "OrderService",
      resolution_status: "resolved" | "ambiguous" | "not_found",
      candidates: [
        { file: "order.service.ts", code_snapshot: "..." }
        // si resolution_status === "ambiguous", plusieurs candidats ici
      ]
    }
  ]
}
```

Ce tool doit :
1. Charger l'index déjà produit par l'Indexeur (Phase 1) pour un repo donné
2. Résoudre chaque appel du `local_call_graph` en cherchant, dans le même
   module/dossier, une méthode du même nom appartenant à une classe qui
   correspond à `injected_type` — via la symbol table construite en Phase 1
3. Si `depth > 1`, résoudre récursivement les appels sortants des fonctions
   trouvées (jusqu'à la profondeur demandée)
4. Si aucune correspondance nette n'est trouvée, ou si plusieurs candidats
   existent, retourner `resolution_status: "ambiguous"` avec la liste des
   candidats — ne jamais deviner silencieusement, l'ambiguïté doit être
   visible dans la sortie

## Contrainte

Utilise le SDK MCP officiel (TypeScript) pour exposer ce tool — ne
réinvente pas le protocole à la main. Si tu as un doute sur la forme exacte
attendue par le SDK MCP, vérifie sa documentation avant de coder, ne
suppose pas.

## Cas de test à valider

Utilise la fixture de la Phase 1 (`OrderController` avec `getOrder` et
`getPublicOrder`), plus un deuxième fichier fixture :

```typescript
// order.service.ts
export class OrderService {
  async findById(id: string) {
    return this.db.orders.findOne({ id }); // pas de filtre userId → IDOR potentiel
  }
  async findPublicById(id: string) {
    return this.db.publicOrders.findOne({ id });
  }
}
```

Appelle `get_context("/orders/:id", depth=2)` via un client MCP de test et
vérifie que la réponse contient bien le code de `findById` résolu
correctement (pas ambigu, un seul `OrderService` dans le projet de test).

Ajoute un deuxième cas de test avec un `UserService` qui a AUSSI une
méthode `findById`, pour vérifier que le `resolution_status` reste
`"resolved"` (grâce à la désambiguïsation par `injected_type`) et ne
devient pas `"ambiguous"` à tort.

## Livrable attendu

- `src/mcp-server/server.ts` — le serveur MCP
- `src/mcp-server/resolver.ts` — la logique de résolution de la symbol table
- `src/mcp-server/server.test.ts` — les tests ci-dessus, exécutés réellement
- Mise à jour de `ROADMAP.md`
