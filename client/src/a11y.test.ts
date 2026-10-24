// Accessibility helpers (P8-03).
import { describe, expect, it } from 'vitest';
import { providerShape, reducedMotion, setMotion, shapeGlyph } from './a11y';

describe('a11y', () => {
  it('every built-in provider has its own shape; custom ones are stable', () => {
    const shapes = ['claude-code', 'gemini-cli', 'codex'].map(providerShape);
    expect(new Set(shapes).size).toBe(3);
    expect(providerShape('custom:helper')).toBe(providerShape('custom:helper'));
    expect(['triangle', 'hexagon', 'star']).toContain(providerShape('custom:demo'));
    expect(shapeGlyph('gemini-cli')).toBe('◆');
  });

  it('the motion setting wins over the system', () => {
    setMotion('reduce');
    expect(reducedMotion()).toBe(true);
    setMotion('full');
    expect(reducedMotion()).toBe(false);
    setMotion('auto');
    expect(reducedMotion()).toBe(false); // no matchMedia under Node
  });
});
