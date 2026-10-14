import { describe, expect, it } from 'vitest';
import { widgetPreview } from './preview';

describe('widgetPreview', () => {
  it('gives a preset the title its tile shows and the shape it draws', () => {
    expect(widgetPreview({ widget: 'sold_value', params: { range: 'this_month' } })).toEqual({ title: expect.stringMatching(/^Sold value — /), shape: 'money' });
    expect(widgetPreview({ widget: 'listings_by_status', params: {} }).shape).toBe('donut');
    expect(widgetPreview({ widget: 'new_leads', params: {} }).shape).toBe('columns');
    expect(widgetPreview({ widget: 'agent_activity', params: {} }).shape).toBe('table');
  });

  it('draws a custom tile the way its spec does, defaulted like the tile', () => {
    const base = { dataset: 'leads', measures: ['count'], range: '30d' };
    expect(widgetPreview({ widget: 'custom', params: base }).shape).toBe('figure');
    expect(widgetPreview({ widget: 'custom', params: { ...base, groupBy: ['agent'] } }).shape).toBe('bars');
    expect(widgetPreview({ widget: 'custom', params: { ...base, groupBy: ['day'] } }).shape).toBe('line');
    expect(widgetPreview({ widget: 'custom', params: { ...base, groupBy: ['agent'], viz: 'donut' } }).shape).toBe('donut');
    expect(widgetPreview({ widget: 'custom', params: base }).title).toMatch(/Leads/i);
  });

  it('never throws on a stored widget it cannot read', () => {
    expect(widgetPreview({ widget: 'gone_widget' })).toEqual({ title: 'Widget', shape: 'figure' });
    expect(widgetPreview(null)).toEqual({ title: 'Widget', shape: 'figure' });
    expect(widgetPreview({ widget: 'custom', params: { dataset: 'revenue' } })).toEqual({ title: 'Custom', shape: 'figure' });
    expect(widgetPreview({ widget: 'toString' })).toEqual({ title: 'Widget', shape: 'figure' });
  });
});
