// CAS 2 — SAIN (score attendu <= 0.3)
// La requête croise l'identifiant de la facture ET celui de l'utilisateur.
@Controller('invoices')
export class InvoiceController {
  constructor(
    private invoiceService: InvoiceService,
    private logger: LoggerService,
  ) {}

  @Get('/:id')
  async getInvoice(@Param('id') id: string, @Req() req: Request) {
    return this.invoiceService.findForUser(id, req.user.id);
  }
}
