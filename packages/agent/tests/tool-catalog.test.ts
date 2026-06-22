import { describe, expect, it } from 'vitest';
import { assertToolAllowed, buildToolCatalog } from '../src/tool-catalog.js';

describe('buildToolCatalog', () => {
  it('enables read tools and disables mutating tools by default', () => {
    const cat = buildToolCatalog();
    expect(cat.find((e) => e.name === '/review')).toMatchObject({ mutating: false, enabled: true });
    expect(cat.find((e) => e.name === '/approve')).toMatchObject({
      mutating: true,
      enabled: false,
    });
  });

  it('includes /improve as an enabled read tool (derived from the registry, no longer an orphan)', () => {
    const cat = buildToolCatalog();
    expect(cat.find((e) => e.name === '/improve')).toMatchObject({
      mutating: false,
      enabled: true,
    });
  });

  it('enables a mutating tool only when its grant is present', () => {
    const cat = buildToolCatalog(['approve']);
    expect(cat.find((e) => e.name === '/approve')?.enabled).toBe(true);
    expect(cat.find((e) => e.name === '/needswork')?.enabled).toBe(false);
  });
});

describe('assertToolAllowed', () => {
  const cat = buildToolCatalog(['approve']);

  it('allows read tools and granted mutating tools', () => {
    expect(() => assertToolAllowed('/review', cat)).not.toThrow();
    expect(() => assertToolAllowed('/approve', cat)).not.toThrow();
  });

  it('rejects ungranted mutating tools (red line)', () => {
    expect(() => assertToolAllowed('/needswork', cat)).toThrow(/guardrail/);
  });

  it('rejects unknown tools', () => {
    expect(() => assertToolAllowed('/bogus', cat)).toThrow(/Unknown tool/);
  });
});
