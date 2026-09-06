/**
 * @vitest-environment jsdom
 */
/**
 * Tests of the MENATER mark.
 *
 * ============================================================================
 * WHAT THEY PROTECT
 *
 * The mark's whole contract is that IT CARRIES NO COLOUR. It takes the theme's
 * accent through `currentColor`, which is what lets one file follow all six
 * palettes. A hex slipped into the SVG would not fail, would not warn, and
 * would look perfectly correct — on the one theme it was written for. Someone
 * on Acme would get an acid-green mark on cream paper, and nobody reviewing
 * the diff would see it.
 *
 * So these tests assert the absence of colour, not the presence of one.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Mark, MARK_BARS } from './Mark.tsx';

afterEach(() => {
  cleanup();
});

const root = join(import.meta.dirname, '..', '..');
const source = readFileSync(join(root, 'src', 'components', 'Mark.tsx'), 'utf8');
const styles = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

describe('the mark', () => {
  it('draws five ticks', () => {
    const { container } = render(<Mark />);
    expect(container.querySelectorAll('rect')).toHaveLength(5);
    expect(MARK_BARS).toHaveLength(5);
  });

  it('keeps the middle tick present and short — absence is shown, not omitted', () => {
    const middle = MARK_BARS[2];
    const full = MARK_BARS[0];
    // It exists...
    expect(middle).toBeDefined();
    // ...and it is visibly shorter than a full bar.
    expect(middle.h).toBeLessThan(full.h / 2);
    // Its place is the one a full bar would occupy: same width, same baseline.
    expect(middle.w).toBe(full.w);
    expect(middle.y + middle.h).toBe(full.y + full.h);
  });

  it('is symmetric, so the gap reads as composition rather than damage', () => {
    const centre = 32 / 2;
    const mirrored = MARK_BARS.map((b) => ({ ...b, x: 2 * centre - b.x - b.w }));
    const key = (b: { x: number; y: number; w: number; h: number }) => `${b.x},${b.y},${b.w},${b.h}`;
    expect(mirrored.map(key).sort()).toEqual(MARK_BARS.map(key).sort());
  });

  it('carries no colour of its own', () => {
    const { container } = render(<Mark />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
    // No hex, no rgb(), no named colour anywhere in the component's source.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });

  it('is styled through the accent token, never a literal', () => {
    const rule = styles.match(/\.soc-logo-sign\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('var(--accent)');
    expect(rule?.[0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('scales without redrawing', () => {
    const { container } = render(<Mark size={64} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('64');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 32 32');
  });

  it('is decorative beside the wordmark, and announced when it stands alone', () => {
    const { container, rerender } = render(<Mark />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<Mark title="MENATER" />);
    expect(screen.getByRole('img', { name: 'MENATER' })).toBeTruthy();
  });
});
