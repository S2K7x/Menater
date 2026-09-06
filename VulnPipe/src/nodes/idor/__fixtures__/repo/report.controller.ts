// CAS 3 — ZONE GRISE (score attendu entre 0.4 et 0.7, reason missing_context)
// Un guard d'autorisation est DÉCLARÉ, mais la classe OwnershipGuard n'existe
// nulle part dans ce repo : le MCP ne peut pas en résoudre le code, donc on ne
// peut pas savoir ce qu'il vérifie réellement.
@Controller('reports')
export class ReportController {
  constructor(private reportService: ReportService) {}

  @UseGuards(OwnershipGuard)
  @Get('/:id')
  async getReport(@Param('id') id: string) {
    return this.reportService.findById(id);
  }
}
