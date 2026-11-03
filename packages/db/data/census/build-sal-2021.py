"""
Builds abs-census-2021-sal.csv from the ABS 2021 Census General Community Profile DataPack for Suburbs and Localities
(ADR 0080, C5 decision 3). Standard library only. Run with -I, pointing at the folder the DataPack was unzipped into:

    python3 -I build-sal-2021.py <unzipped-datapack-dir> > abs-census-2021-sal.csv

Source: https://www.abs.gov.au/census/find-census-data/datapacks (2021, GCP, Suburbs and Localities, short header).
Housing figures ONLY (decision 3): people, dwellings by structure, tenure, median rent, median mortgage repayment,
average household size. Income, age, ancestry and religion are in the DataPack and deliberately not taken.
A median of 0 in the DataPack means "not available" (a small locality) and is written as an empty cell.
"""
import csv
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

D = sys.argv[1]
STATE = {'1': 'NSW', '2': 'VIC', '3': 'QLD', '4': 'SA', '5': 'WA', '6': 'TAS', '7': 'NT', '8': 'ACT'}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def table(name):
    with open(f'{D}/2021Census_{name}_AUST_SAL.csv', newline='') as f:
        return {row['SAL_CODE_2021']: row for row in csv.DictReader(f)}


def sal_names():
    z = zipfile.ZipFile(f'{D}/2021Census_geog_desc_1st_2nd_3rd_release.xlsx')
    strings = [''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
    out = {}
    for r in ET.fromstring(z.read('xl/worksheets/sheet6.xml')).iter('{%s}row' % NS['m']):
        vals = []
        for c in r.findall('m:c', NS):
            v = c.find('m:v', NS)
            vals.append('' if v is None else (strings[int(v.text)] if c.get('t') == 's' else v.text))
        if len(vals) > 3 and vals[0] == 'SAL':
            out[vals[1]] = vals[3]
    return out


def num(row, col, *, zero_is_unknown=False):
    v = (row or {}).get(col, '').strip()
    if v == '' or (zero_is_unknown and float(v) == 0):
        return ''
    return v


names = sal_names()
g01, g02, g36, g37 = table('G01'), table('G02'), table('G36'), table('G37')
w = csv.writer(sys.stdout)
w.writerow(['sal_code', 'name', 'state', 'population', 'dwellings', 'separate_houses', 'semi_detached', 'flats', 'owned_outright', 'owned_mortgage', 'rented', 'tenure_total', 'median_rent_weekly', 'median_mortgage_monthly', 'avg_household_size'])
for code in sorted(g01):
    state = STATE.get(code[3:4])
    if not state or code not in names:
        continue  # Other Territories, or a code with no name.
    name = re.sub(r'\s+\((NSW|Vic\.|Qld|SA|WA|Tas\.|NT|ACT)\)$', '', names[code]).strip()
    a, b, c, d = g01.get(code), g02.get(code), g36.get(code), g37.get(code)
    w.writerow([
        code, name, state,
        num(a, 'Tot_P_P'),
        num(c, 'OPDs_Tot_OPDs_Dwellings'), num(c, 'OPDs_Separate_house_Dwellings'), num(c, 'OPDs_SD_r_t_h_th_Tot_Dwgs'), num(c, 'OPDs_Flt_apart_Tot_Dwgs'),
        num(d, 'O_OR_Total'), num(d, 'O_MTG_Total'), num(d, 'R_Tot_Total'), num(d, 'Total_Total'),
        num(b, 'Median_rent_weekly', zero_is_unknown=True), num(b, 'Median_mortgage_repay_monthly', zero_is_unknown=True), num(b, 'Average_household_size', zero_is_unknown=True),
    ])
