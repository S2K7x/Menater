export class OrderService {
  async findById(id: string) {
    return this.db.orders.findOne({ id }); // aucun filtre userId -> IDOR
  }
}
