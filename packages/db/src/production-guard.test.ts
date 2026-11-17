import { describe, expect, it } from 'vitest';
import { productionRefusal } from './production-guard';

const prod = 'postgresql://postgres.xjklpoyxcvnlhjlxasmv:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const dev = 'postgresql://postgres.jhialeuioqqlwpzukdzo:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

describe('production guard', () => {
  it('refuses the live project by default, on the pooler and the direct host', () => {
    expect(productionRefusal(prod, {})).toMatch(/PRODUCTION.*CONFIRM_PRODUCTION=xjklpoyxcvnlhjlxasmv/);
    expect(productionRefusal('postgresql://postgres:pw@db.xjklpoyxcvnlhjlxasmv.supabase.co:5432/postgres', {})).not.toBeNull();
  });
  it('lets dev and unknown databases through', () => {
    expect(productionRefusal(dev, {})).toBeNull();
    expect(productionRefusal('postgresql://localhost/test', {})).toBeNull();
    expect(productionRefusal(undefined, {})).toBeNull();
  });
  it('runs on production only when that exact ref is confirmed', () => {
    expect(productionRefusal(prod, { CONFIRM_PRODUCTION: 'xjklpoyxcvnlhjlxasmv' })).toBeNull();
    expect(productionRefusal(prod, { CONFIRM_PRODUCTION: 'yes' })).not.toBeNull();
    expect(productionRefusal(prod, { CONFIRM_PRODUCTION: 'jhialeuioqqlwpzukdzo' })).not.toBeNull();
  });
  it('honours PRODUCTION_DB_REFS', () => {
    expect(productionRefusal(dev, { PRODUCTION_DB_REFS: 'abc, jhialeuioqqlwpzukdzo' })).not.toBeNull();
    expect(productionRefusal(prod, { PRODUCTION_DB_REFS: 'abc' })).toBeNull();
  });
});
