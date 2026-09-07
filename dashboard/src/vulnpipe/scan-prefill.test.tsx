/**
 * @vitest-environment jsdom
 */
/**
 * J0.3 — a target handed to the Code tab by an incident card.
 *
 * WHY THIS FILE EXISTS AT ALL. The Code tab is mounted on its first visit and
 * then kept mounted, because unmounting it would cut a running scan. So the
 * launcher below it survives every later jump, and `defaultPath` is an INITIAL
 * value — the launcher owns its field afterwards, which is what lets someone
 * edit the target. Handing it a second repository therefore does nothing at
 * all unless the component is re-keyed, and the failure is silent: the tab
 * opens, a path is in the box, and it is the previous alert's.
 *
 * That is the whole risk of the feature, so it is the thing under test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { I18nProvider } from '../i18n/context.tsx';
import { DEFAULT_LOCALE } from '../i18n/dictionary.ts';
import { ThemeProvider } from '../theme/context.tsx';
import { VulnPipeSection, type ScanPrefill } from './VulnPipeSection.tsx';

afterEach(cleanup);

/**
 * The providers are part of the tree on purpose.
 *
 * `test-utils`'s `render` wraps them once, but the `rerender` it hands back
 * replaces the children WITHOUT them — and re-rendering is exactly what the
 * second test needs to do.
 */
const tree = (prefill: ScanPrefill | null) => (
  <ThemeProvider>
    <I18nProvider initialLocale={DEFAULT_LOCALE}>
      <VulnPipeSection prefill={prefill} />
    </I18nProvider>
  </ThemeProvider>
);

/** The launcher's single target field, by its id rather than its question. */
const targetField = (): HTMLInputElement =>
  document.querySelector('#vp-target') as HTMLInputElement;

describe('a repository carried in from an alert', () => {
  it('arrives in the launcher, ready to be launched by a human', () => {
    render(tree({ target: '/srv/src/orders-api', n: 1 }));
    expect(targetField().value).toBe('/srv/src/orders-api');
  });

  it('is REPLACED when a second alert sends another one', () => {
    const { rerender } = render(tree({ target: '/srv/src/orders-api', n: 1 }));
    rerender(tree({ target: '/srv/src/billing-api', n: 2 }));
    expect(targetField().value).toBe('/srv/src/billing-api');
  });

  it('leaves the launcher alone when nobody sent anything', () => {
    render(tree(null));
    expect(targetField().value).toBe('');
  });

  /**
   * A repository URL shown under the "folder" tab would be explained by help
   * text about folders. The tabs constrain nothing — the analysis service
   * recognises the form itself — so this only picks which example is shown.
   */
  it('opens on the repository tab when the target is a URL', () => {
    render(tree({ target: 'https://github.com/acme/orders', n: 1 }));
    const selected = screen
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toMatch(/repository|github/i);
  });
});
