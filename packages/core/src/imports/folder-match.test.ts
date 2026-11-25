import { describe, expect, it } from 'vitest';
import { matchFolder, type MatchRow } from './folder-match';

const row = (rowId: string, rowNumber: number, a: Partial<MatchRow>): MatchRow => ({
  rowId, rowNumber, externalId: null, suburb: 'Pakenham', state: 'VIC', postcode: '3810', hasLinks: false, ...a,
});
const henry = row('henry', 2, { streetNumber: '14', street: 'Henry Street', externalId: 'AG-1001' });
const unit = row('unit', 3, { unit: '2', streetNumber: '6E', street: 'Main St', suburb: 'Officer', postcode: '3809' });
const six = row('six', 4, { streetNumber: '6', street: 'Main Street', suburb: 'Officer', postcode: '3809' });
const f = (path: string, size = 1000) => ({ path, size });
const paths = (m: ReturnType<typeof matchFolder>, id: string) => (m.byRow.get(id) ?? []).map((p) => p.path);

describe('matchFolder: which listing each dropped photo belongs to (ADR 0102)', () => {
  it('matches an address folder at any depth, however the address is spelt', () => {
    const m = matchFolder([henry], [
      f('2026 Listings/Pakenham/14 Henry Street Pakenham/Photos/1.jpg'),
      f('14 Henry St/2.jpg'),
      f('14 henry street pakenham vic 3810/3.jpg'),
      f('14_Henry_St.,_Pakenham/4.jpg'),
    ]);
    expect(paths(m, 'henry')).toHaveLength(4);
    expect(m.unmatchedFolders).toEqual([]);
  });

  it('the deepest folder that names a listing wins', () => {
    const m = matchFolder([henry, six], [f('14 Henry Street/6 Main Street Officer/1.jpg')]);
    expect(paths(m, 'six')).toHaveLength(1);
    expect(paths(m, 'henry')).toHaveLength(0);
  });

  it('reads "2-6E", "Unit 2 6E" and "U2 6E" as unit 2 of 6E, and never as 6 or 6E alone', () => {
    const m = matchFolder([unit, six], [f('2-6E Main St/a.jpg'), f('Unit 2 6E Main Street Officer/b.jpg'), f('U2 6E Main St/c.jpg'), f('6E Main St/d.jpg')]);
    expect(paths(m, 'unit')).toEqual(['2-6E Main St/a.jpg', 'U2 6E Main St/c.jpg', 'Unit 2 6E Main Street Officer/b.jpg']);
    expect(paths(m, 'six')).toEqual([]);
    expect(m.unmatchedFolders).toEqual(['6E Main St']);
  });

  it('a word after the address that is not this listing’s suburb, state or postcode is not a match', () => {
    const m = matchFolder([henry], [f('14 Henry Street Officer/1.jpg'), f('14 Henry Street old/2.jpg')]);
    expect(paths(m, 'henry')).toEqual([]);
    expect(m.unmatchedFolders).toHaveLength(2);
  });

  it('a folder that names two listings gets neither', () => {
    const other = row('other', 9, { streetNumber: '14', street: 'Henry St', suburb: 'Berwick', postcode: '3806' });
    const m = matchFolder([henry, other], [f('14 Henry Street/1.jpg'), f('14 Henry Street Berwick/2.jpg')]);
    expect(m.ambiguous).toEqual([{ folder: '14 Henry Street', rows: [2, 9] }]);
    expect(paths(m, 'henry')).toEqual([]);
    expect(paths(m, 'other')).toEqual(['14 Henry Street Berwick/2.jpg']);
  });

  it('matches a folder named by the listing id', () => {
    expect(paths(matchFolder([henry], [f('photos/ag-1001/1.jpg')]), 'henry')).toEqual(['photos/ag-1001/1.jpg']);
  });

  it('orders photos naturally, marks floorplans, and reports what is over the limit', () => {
    const files = Array.from({ length: 22 }, (_, i) => f(`14 Henry St/${i + 1}.jpg`));
    const m = matchFolder([henry], [...files, f('14 Henry St/Floor Plans/plan.png')]);
    const planned = m.byRow.get('henry')!;
    expect(planned.slice(0, 3).map((p) => p.path)).toEqual(['14 Henry St/1.jpg', '14 Henry St/2.jpg', '14 Henry St/3.jpg']);
    expect(planned.filter((p) => !p.kind)).toHaveLength(20);
    expect(planned.find((p) => p.kind === 'floorplan')?.path).toBe('14 Henry St/Floor Plans/plan.png');
    expect(m.skipped.map((s) => s.path)).toEqual(['14 Henry St/21.jpg', '14 Henry St/22.jpg']);
  });

  it('ignores junk and other files, reports HEIC and huge originals', () => {
    const m = matchFolder([henry], [f('14 Henry St/.DS_Store'), f('__MACOSX/14 Henry St/1.jpg'), f('14 Henry St/notes.pdf'), f('14 Henry St/IMG_1.HEIC'), f('14 Henry St/big.jpg', 50 * 1024 * 1024)]);
    expect(m.byRow.size).toBe(0);
    expect(m.skipped.map((s) => s.reason)).toEqual(['An iPhone HEIC photo: save it as JPEG first', 'Larger than 40 MB']);
    expect(m.unmatchedFolders).toEqual([]);
  });

  it('a listing with photo links in the file keeps them; its folder is reported, not used', () => {
    const m = matchFolder([{ ...henry, hasLinks: true }], [f('14 Henry St/1.jpg')]);
    expect(m.byRow.size).toBe(0);
    expect(m.linksWin).toEqual([2]);
  });

  it('folders that are not addresses never match', () => {
    const m = matchFolder([henry, unit, six], [f('Photos/1.jpg'), f('2026 Listings/Pakenham/2.jpg'), f('3.jpg')]);
    expect(m.byRow.size).toBe(0);
    expect(m.unmatchedFolders).toEqual(['(top of the folder)', '2026 Listings/Pakenham', 'Photos']);
  });
});
