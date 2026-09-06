import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { I18nProvider } from './i18n/context.tsx';
import { ThemeProvider } from './theme/context.tsx';
import './styles.css';
import './vulnpipe/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* La langue de la section VulnPipe est un etat global : le fournisseur
        doit envelopper toute l'application, meme si un seul onglet s'en sert.
        Le monter a l'interieur de l'onglet le remonterait a chaque changement
        d'onglet, et le choix de langue serait perdu en revenant.

        `fallbackLocale` ouvre la section en francais — la langue de la console
        — tant que personne n'a touche au selecteur. Un choix deja fait, lui,
        est conserve. */}
    {/* Le theme enveloppe la langue : il ne depend de rien, et le poser au
        plus haut evite qu'un changement de langue puisse le remonter. */}
    <ThemeProvider>
      <I18nProvider fallbackLocale="en">
        <App />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
