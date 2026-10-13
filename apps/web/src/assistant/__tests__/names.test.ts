import { describe, expect, it } from 'vitest';
import { authorLine, surname } from '../names';

describe('surname', () => {
  it('reads BibTeX order and keeps particles of display names', () => {
    expect(surname('De Cubber, Geert')).toBe('De Cubber');
    expect(surname('Geert De Cubber')).toBe('De Cubber');
    expect(surname('Ludwig van Beethoven')).toBe('van Beethoven');
    expect(surname('Daniela Doroftei')).toBe('Doroftei');
    expect(surname('Plato')).toBe('Plato');
    expect(authorLine(['Geert De Cubber', 'Daniela Doroftei'])).toBe('De Cubber & Doroftei');
  });
});
