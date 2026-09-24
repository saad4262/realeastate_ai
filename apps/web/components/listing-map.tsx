'use client';

import { MapView } from '@repo/ui/maps';

/**
 * Where a single listing is.
 *
 * Rendered only when the property has been pinned. A map centred on a suburb
 * because the pin is missing tells a buyer the house is somewhere it is not,
 * which is worse than showing no map at all.
 */
export function ListingMap({
  latitude,
  longitude,
  label,
}: {
  latitude: number | null;
  longitude: number | null;
  label: string;
}) {
  if (latitude === null || longitude === null) return null;

  return (
    <MapView
      pins={[{ id: 'listing', lat: latitude, lng: longitude, label }]}
      height={300}
      zoom={16}
    />
  );
}
