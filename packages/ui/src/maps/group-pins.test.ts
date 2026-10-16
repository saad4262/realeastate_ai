import { describe, expect, it } from 'vitest';
import { groupPins, metresBetween } from './group-pins';

/**
 * Units of one building share a geocode. Every one of them must stay
 * reachable: same spot = one marker listing them all; next door = its own.
 */

// The real pins from production, 2026-10-16: 1/14 and 2/14 identical, 14 about 12 m away.
const unit1 = { id: 'u1', lat: -38.07706, lng: 145.484861, label: '1/14 Henry Street' };
const unit2 = { id: 'u2', lat: -38.07706, lng: 145.484861, label: '2/14 Henry Street' };
const house14 = { id: 'h14', lat: -38.07699, lng: 145.484966, label: '14 Henry Street' };
const house12 = { id: 'h12', lat: -38.076996, lng: 145.484689, label: '12 Henry Street' };

describe('groupPins', () => {
  it('units at the exact same point become one group, each still listed', () => {
    const groups = groupPins([unit1, house14, unit2]);
    expect(groups.map((g) => g.pins.map((p) => p.id))).toEqual([['u1', 'u2'], ['h14']]);
  });
  it('next-door houses stay markers of their own', () => {
    expect(metresBetween(house14, unit1)).toBeGreaterThan(10);
    expect(groupPins([house12, house14]).map((g) => g.pins.length)).toEqual([1, 1]);
  });
  it('a metre of geocoding noise is still the same spot', () => {
    const noisy = { ...unit2, lat: unit2.lat + 0.000008 }; // ~0.9 m north
    expect(groupPins([unit1, noisy])).toHaveLength(1);
  });
  it('no pins, no groups; one pin, one group', () => {
    expect(groupPins([])).toEqual([]);
    expect(groupPins([house14])).toEqual([{ lat: house14.lat, lng: house14.lng, pins: [house14] }]);
  });
});
