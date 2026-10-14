import { effectiveViz, type TileSpec, type Viz } from '../semantic';
import { WIDGETS, type WidgetId } from '../widgets/registry';
import type { OpenTileSpec, OpenViz } from '../open-query/tile';

/**
 * A dashboard's thumbnail (the Projects grid): each widget's title and the
 * shape its tile draws — read from the stored widget list alone.
 *
 * No figures, on purpose. A tile's numbers are computed as the viewer on every
 * render (ADR 0027); a list of thumbnails would need every widget of every
 * dashboard run, and there is no one picture of a board that is true for
 * everyone who can open it. The shape and the title are the same for all.
 */

export const PREVIEW_SHAPES = ['figure', 'money', 'bars', 'columns', 'donut', 'line', 'table'] as const;
export type PreviewShape = (typeof PREVIEW_SHAPES)[number];
export type WidgetPreview = { title: string; shape: PreviewShape };

/** What each preset's tile draws (components/dashboards/tile.tsx). */
const PRESET_SHAPES: Record<Exclude<WidgetId, 'custom' | 'open'>, PreviewShape> = {
  sold_value: 'money',
  sold_count: 'bars',
  new_leads: 'columns',
  upcoming_appointments: 'bars',
  listings_by_status: 'donut',
  email_replies: 'figure',
  agent_activity: 'table',
};

const VIZ_SHAPES: Record<Viz, PreviewShape> = {
  number: 'figure',
  bar: 'bars',
  line: 'line',
  table: 'table',
  donut: 'donut',
  columns: 'columns',
};

const OPEN_SHAPES: Record<OpenViz, PreviewShape> = { number: 'figure', table: 'table', bar: 'bars', line: 'line', donut: 'donut' };

/** One stored widget (`dashboard.widgets[i]`) as its preview. Anything unreadable falls back to a plain figure. */
export function widgetPreview(ref: unknown): WidgetPreview {
  const r = (ref ?? {}) as { widget?: unknown; params?: unknown };
  if (typeof r.widget !== 'string' || !Object.hasOwn(WIDGETS, r.widget)) return { title: 'Widget', shape: 'figure' };
  const id = r.widget as WidgetId;
  const def = WIDGETS[id];
  const parsed = def.params.safeParse(r.params ?? {});
  if (!parsed.success) return { title: def.title, shape: id === 'custom' || id === 'open' ? 'figure' : PRESET_SHAPES[id] };
  try {
    // The same words the tile shows as its title (renderWidget's `description`).
    const title = (def.describe as (p: unknown) => string)(parsed.data);
    const shape =
      id === 'custom' ? VIZ_SHAPES[effectiveViz(parsed.data as TileSpec)] : id === 'open' ? OPEN_SHAPES[(parsed.data as OpenTileSpec).viz] : PRESET_SHAPES[id];
    return { title, shape };
  } catch {
    return { title: def.title, shape: 'figure' };
  }
}
