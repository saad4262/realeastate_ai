import type { MapPin } from './map-view';

/**
 * Pins standing on the same spot, as one group.
 *
 * Units in one building share a geocode: "1/14", "2/14" and often "14" itself
 * come back from Google as the building's single point. Drawn as one marker
 * each, they sit exactly on top of one another and only the top one can be
 * clicked — the others cannot be reached at all, at any zoom. So pins within
 * `metres` of the group's first pin become ONE marker with a count, and its
 * popup lists every one of them to choose from.
 *
 * The distance is small on purpose: it folds pins that cannot be told apart
 * on any map, and leaves next-door houses (10 m and more apart) as markers of
 * their own, which zooming in separates.
 *
 * Pure, and order-preserving (groups appear in the order of their first pin,
 * pins within a group in their given order), so it is tested without a map.
 */
export type PinGroup = { lat: number; lng: number; pins: MapPin[] };

/** Same spot: closer than this is one place on any map a person can read. */
export const SAME_SPOT_METRES = 3;

const EARTH_METRES = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance in metres; equirectangular, which is exact enough at a few metres. */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * EARTH_METRES;
}

export function groupPins(pins: MapPin[], metres = SAME_SPOT_METRES): PinGroup[] {
  const groups: PinGroup[] = [];
  for (const pin of pins) {
    const home = groups.find((g) => metresBetween(g, pin) <= metres);
    if (home) home.pins.push(pin);
    else groups.push({ lat: pin.lat, lng: pin.lng, pins: [pin] });
  }
  return groups;
}
