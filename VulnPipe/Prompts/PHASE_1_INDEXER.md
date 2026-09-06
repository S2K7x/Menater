# Prompt — Phase 1 : Indexeur Tree-sitter

Copie ce prompt tel quel dans une nouvelle session Claude Code, à la racine
du repo (après avoir mis `CLAUDE.md` et `ROADMAP.md` à la racine).

---

## Contexte

Tu construis le premier composant de **VulnPipe**, une pipeline de scan de
sécurité automatisée pour du code applicatif. Lis d'abord `CLAUDE.md` à la
racine du repo pour comprendre l'architecture globale — ce prompt ne couvre
qu'une seule brique : **l'Indexeur**.

## Objectif de cette phase

Écrire un script Node.js/TypeScript qui utilise **tree-sitter** pour :
1. Parser un fichier contrôleur (on démarre sur NestJS, syntaxe à base de
   décorateurs `@Controller`, `@Get`, `@UseGuards`)
2. Extraire chaque route : méthode HTTP, path, nom du handler, décorateurs
   (notamment les guards/middlewares d'autorisation)
3. Extraire le call graph local (toutes les fonctions/méthodes appelées à
   l'intérieur du corps du handler)
4. Construire une **symbol table légère** indexée par
   `(nom_de_classe_du_type_injecté, nom_de_méthode)` pour désambiguïser les
   appels comme `this.orderService.findById(id)` — récupère le type injecté
   via le constructeur (`private orderService: OrderService`), PAS via un
   compilateur TypeScript complet (voir contrainte ci-dessous).

## Contrainte critique — à respecter absolument

**Tu ne connais pas avec certitude la forme exacte des objets retournés par
l'API `Query.matches()` du binding tree-sitter que tu vas utiliser** (elle
diffère entre `node-tree-sitter` natif et `web-tree-sitter`/WASM, et entre
versions). Donc :

1. Avant d'écrire la moindre logique d'extraction, écris un script minimal
   qui parse un exemple de code et fait un `console.dir(matches[0], { depth: null })`
   pour voir la vraie structure retournée par TA version installée.
2. Colle cette sortie réelle dans un commentaire en haut du fichier
   `indexer.ts`, pour que la prochaine session sache sur quelle API elle
   travaille.
3. Construis la logique d'extraction seulement après avoir vérifié cette
   structure — ne suppose jamais qu'un champ existe sans l'avoir vu dans la
   sortie réelle.

## Cas de test à valider (obligatoire, pas optionnel)

Utilise ce fichier comme fixture de test :

```typescript
@Controller('orders')
export class OrderController {
  constructor(
    private orderService: OrderService,
    private logger: LoggerService,
  ) {}

  @UseGuards(OwnershipGuard)
  @Get('/:id')
  async getOrder(@Param('id') id: string, @Req() req: Request) {
    this.logger.log('Fetching order');
    return this.orderService.findById(id);
  }

  @Get('/public/:id')
  async getPublicOrder(@Param('id') id: string) {
    return this.orderService.findPublicById(id);
  }
}
```

Le script doit produire un JSON de cette forme (les valeurs sont indicatives,
la structure est ce qui compte) :

```json
{
  "controller": "OrderController",
  "endpoints": [
    {
      "route": "/orders/:id",
      "http_method": "Get",
      "handler": "getOrder",
      "framework_metadata": { "decorators": ["@UseGuards(OwnershipGuard)"] },
      "local_call_graph": [
        { "call": "findById", "injected_type": "OrderService" },
        { "call": "log", "injected_type": "LoggerService" }
      ],
      "code_snapshot": "..."
    },
    {
      "route": "/orders/public/:id",
      "http_method": "Get",
      "handler": "getPublicOrder",
      "framework_metadata": { "decorators": [] },
      "local_call_graph": [
        { "call": "findPublicById", "injected_type": "OrderService" }
      ],
      "code_snapshot": "..."
    }
  ]
}
```

Ajoute un test automatisé (Jest ou Vitest, au choix) qui vérifie cette
sortie sur la fixture ci-dessus. Ne considère pas la phase terminée tant
que ce test ne passe pas réellement (exécute-le, ne te contente pas de
l'écrire).

## Ce qui n'est PAS dans le scope de cette phase

- Pas de résolution cross-fichier (aller lire le vrai fichier
  `order.service.ts`) — ça, c'est le rôle du serveur MCP en Phase 2, qui
  consommera cette symbol table.
- Pas de support Python/Go — TypeScript/NestJS uniquement pour ce MVP.
- Pas de gestion des alias de chemin `tsconfig.json` (`@/modules/...`) —
  seulement les imports relatifs classiques pour l'instant.

## Livrable attendu

- `src/indexer/indexer.ts` — le moteur d'extraction
- `src/indexer/queries.ts` — les requêtes S-expression tree-sitter
- `src/indexer/indexer.test.ts` — le test sur la fixture ci-dessus, qui passe réellement
- Mise à jour de `ROADMAP.md` : coche la case Phase 1, note en une ligne
  toute limitation découverte en cours de route
