export class InvoiceService {
  async findForUser(id: string, userId: string) {
    return this.db.invoices.findOne({ id, userId });
  }
}
