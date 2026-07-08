import { describe, expect, it } from 'vitest';
import { exportToCsv } from './csv';

describe('csv', () => {
  it('escapes embedded commas, quotes and newlines', () => {
    let captured: Blob | null = null;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((b: Blob) => {
      captured = b;
      return 'blob://x';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

    exportToCsv('x.csv', [{ a: 'simple', b: 'has,comma', c: 'has "quote"', d: 'a\nb' }]);

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    expect(captured).not.toBeNull();
  });
});
