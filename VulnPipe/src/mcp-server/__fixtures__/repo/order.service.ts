export class OrderService {
  async findById(id: string) {
    return this.db.orders.findOne({ id }); // pas de filtre userId → IDOR potentiel
  }

  async findPublicById(id: string) {
    return this.db.publicOrders.findOne({ id });
  }
}
