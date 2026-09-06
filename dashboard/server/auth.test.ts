/**
 * Tests du verrou d'accès.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Une seule chose, mais elle est structurante : le point d'entrée des alertes
 * n'est pas soumis au verrou HUMAIN de la console, parce qu'il porte sa propre
 * authentification. Le lui appliquer casserait l'ingestion dès qu'on protège
 * la console — et pousserait à désactiver l'un des deux.
 *
 * L'inverse est tout aussi important : aucune AUTRE route ne doit rejoindre
 * cette liste par inadvertance.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.ts', () => ({ getConfig: () => ({ auth: { enabled: true } }) }));

const { requiresAuth } = await import('./auth.ts');

describe('verrou d’accès de la console', () => {
  it('protège les routes de la console', () => {
    for (const path of ['/api/snapshot', '/api/settings', '/api/workflows', '/api/rules']) {
      expect(requiresAuth(path), path).toBe(true);
    }
  });

  it('laisse passer ce qui permet de se connecter', () => {
    for (const path of ['/api/auth/status', '/api/auth/login', '/api/auth/logout']) {
      expect(requiresAuth(path), path).toBe(false);
    }
  });

  it('EXEMPTE le point d’entrée des alertes — il a sa propre authentification', () => {
    // Un équipement qui émet une alerte n'a pas de session de navigateur.
    expect(requiresAuth('/api/webhook/soc/alert')).toBe(false);
  });

  it('EXEMPTE aussi les points d’entrée par source — c’était un défaut', () => {
    // N4 a ajouté `/api/ingest/:source` à côté du chemin historique sans
    // l'ajouter à la liste, qui compare des chaînes exactes. Conséquence : dès
    // qu'on posait un mot de passe sur la console, chaque agent Wazuh recevait
    // un 401 « connectez-vous » sur un endpoint qui s'authentifie par secret
    // partagé et n'a jamais eu de cookie de session.
    for (const path of ['/api/ingest/wazuh', '/api/ingest/generic', '/api/ingest/my-siem-2']) {
      expect(requiresAuth(path), path).toBe(false);
    }
  });

  it('garde le CATALOGUE des sources et le plan de contrôle derrière le verrou', () => {
    // `/api/ingest/sources` distribue les extraits d'installation : c'est de la
    // console, pas de l'ingestion. Et le plan de contrôle vit sous
    // `/api/ingestion/` précisément pour que la règle reste une seule forme
    // sans exception à rallonger.
    for (const path of [
      '/api/ingest/sources',
      '/api/ingestion/policy', '/api/ingestion/poll',
      // Rien qui ressemble de loin : un segment de plus, une majuscule, un
      // point — la regex ne doit ouvrir que ce qu'elle annonce.
      '/api/ingest/wazuh/extra', '/api/ingest/Wazuh', '/api/ingest/../settings',
    ]) {
      expect(requiresAuth(path), path).toBe(true);
    }
  });

  it('n’exempte AUCUNE autre route d’écriture', () => {
    // Le pendant du test précédent : cette liste ne doit pas s'allonger par
    // inadvertance. Une route d'écriture qui y tomberait serait ouverte à tous.
    for (const path of [
      '/api/workflows/variables', '/api/replay', '/api/simulate', '/api/diagnostics',
      '/api/webhook', '/api/webhook/soc', '/api/webhook/soc/alert/extra',
    ]) {
      expect(requiresAuth(path), path).toBe(true);
    }
  });
});
