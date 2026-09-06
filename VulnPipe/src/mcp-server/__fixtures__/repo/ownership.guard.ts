/**
 * ABSENT DE LA SPEC PHASE 2 — ajouté volontairement.
 *
 * `@UseGuards(OwnershipGuard)` est un DÉCORATEUR, pas un appel : il n'apparaît
 * nulle part dans `local_call_graph`. En suivant la spec à la lettre, le
 * resolver ne serait jamais allé chercher ce fichier.
 *
 * Or c'est exactement ce code qui décide du verdict IDOR : sans lui, le node
 * de la Phase 3 voit deux routes qui appellent toutes les deux un `findById`
 * sans filtre `userId`, et n'a aucun moyen de dire que l'une est protégée et
 * l'autre non.
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(private orderService: OrderService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const order = await this.orderService.findById(request.params.id);
    return order.userId === request.user.id;
  }
}
