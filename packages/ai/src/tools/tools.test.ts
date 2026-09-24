import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';
import { getListingInput } from './get-listing-tool';
import { resolveLocationInput } from './resolve-location';
import { searchListingsInput } from './search-listings-tool';
import { PROPERTY_CHAT_TOOLS } from './index';

/**
 * The JSON Schema shown to the model and the zod schema that guards the query
 * are written separately, on purpose — see the comment in index.ts. The cost
 * of that choice is drift, and this is what makes drift visible.
 */
const PAIRS = [
  { name: 'resolve_location', zod: resolveLocationInput },
  { name: 'search_listings', zod: searchListingsInput },
  { name: 'get_listing', zod: getListingInput },
] as const;

function jsonSchemaOf(name: string) {
  const tool = PROPERTY_CHAT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool definition named ${name}`);
  return tool.input_schema as {
    properties?: Record<string, unknown>;
    required?: string[] | null;
    additionalProperties?: boolean;
  };
}

function zodShape(schema: ZodObject<ZodRawShape>) {
  const shape = schema.shape;
  const all = Object.keys(shape);
  const required = all.filter((key) => !shape[key]!.isOptional());
  return { all, required };
}

describe('tool definitions', () => {
  it.each(PAIRS)('$name — the model and the guard agree on the fields', ({ name, zod }) => {
    const json = jsonSchemaOf(name);
    const shape = zodShape(zod as unknown as ZodObject<ZodRawShape>);

    expect(Object.keys(json.properties ?? {}).sort()).toEqual(shape.all.sort());
    expect((json.required ?? []).sort()).toEqual(shape.required.sort());
  });

  it('requires channel and suburb, which is what makes the guide ask', () => {
    // Gate 1. A model that does not know whether the visitor is buying or
    // renting cannot form the call — enforced by the API, not by a prompt.
    expect(jsonSchemaOf('search_listings').required).toEqual(['channel', 'suburb']);
  });

  it('gives the model no way to name a centre, a status or a page size', () => {
    const props = Object.keys(jsonSchemaOf('search_listings').properties ?? {});
    for (const forbidden of ['lat', 'lng', 'near', 'status', 'limit', 'agencyId']) {
      expect(props).not.toContain(forbidden);
    }
  });

  it('is closed but NOT strict, so optional filters stay optional', () => {
    // strict: true made the model fill every optional field with placeholder
    // junk — keywords "-", priceTo 22 — each of which narrowed the search to
    // nothing while the visitor saw only "no matches". It also makes the API
    // refuse minimum/maximum outright. zod is the guard; this is the contract.
    for (const tool of PROPERTY_CHAT_TOOLS) {
      expect(tool.strict).toBeUndefined();
      expect((tool.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
      expect(tool.description && tool.description.length).toBeGreaterThan(40);
    }
  });

  it('carries no validation keyword the API would refuse', () => {
    // With these present the whole request 400s. They live in the zod schema
    // and in the descriptions instead.
    const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern'];
    for (const tool of PROPERTY_CHAT_TOOLS) {
      const props = Object.values(
        (tool.input_schema as { properties?: Record<string, object> }).properties ?? {},
      );
      for (const prop of props) {
        for (const key of banned) expect(prop).not.toHaveProperty(key);
      }
    }
  });

  it('is frozen and stably ordered, because it is the head of the cache prefix', () => {
    // tools render before system, which renders before messages. A rebuilt or
    // reordered array costs every cache read on the route and says nothing.
    expect(Object.isFrozen(PROPERTY_CHAT_TOOLS)).toBe(true);
    expect(PROPERTY_CHAT_TOOLS.map((t) => t.name)).toEqual([
      'resolve_location',
      'search_listings',
      'get_listing',
    ]);
  });
});
