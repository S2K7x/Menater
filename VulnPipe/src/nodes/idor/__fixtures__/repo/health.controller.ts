// CAS 4 — AUCUNE SURFACE D'ATTAQUE : pas d'identifiant dans l'URL.
// Doit être tranché par le scanner déterministe, SANS appel LLM.
@Controller('health')
export class HealthController {
  @Get('/')
  async check() {
    return { status: 'ok' };
  }
}
