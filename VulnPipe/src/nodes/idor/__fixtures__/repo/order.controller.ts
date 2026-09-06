// CAS 1 — VULNÉRABLE ÉVIDENT (score attendu >= 0.8)
// Aucun guard, et findById ne filtre que sur l'identifiant de la commande.
@Controller('orders')
export class OrderController {
  constructor(private orderService: OrderService) {}

  @Get('/:id')
  async getOrder(@Param('id') id: string) {
    return this.orderService.findById(id);
  }
}
