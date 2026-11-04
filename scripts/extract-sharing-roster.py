"""Read the supplied duty workbook without modifying it; emit the reviewed schedule."""
import argparse
import hashlib
import json
import re
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def extract(path, first_year):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with ZipFile(path) as archive:
        strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', ns)]
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        values = {}
        for cell in sheet.findall('s:sheetData/s:row/s:c', ns):
            raw = cell.find('s:v', ns)
            if raw is not None:
                values[cell.get('r')] = strings[int(raw.text)] if cell.get('t') == 's' else raw.text
        entries, year, last_month, previous_end = [], first_year, None, None
        for row in range(4, 31, 2):
            period, people = values.get(f'A{row}', ''), values.get(f'D{row}', '')
            match = re.fullmatch(r'(\d+)月(\d+)日[~～至—-](\d+)月(\d+)日', period.strip())
            if not match or not people:
                raise ValueError(f'Missing or invalid duty row: {row}')
            start_month, start_day, end_month, end_day = map(int, match.groups())
            if last_month is not None and start_month < last_month:
                year += 1
            start = date(year, start_month, start_day)
            end = date(year + (end_month < start_month), end_month, end_day)
            names = [name.strip() for name in re.split(r'[、，,]', people) if name.strip()]
            if start.weekday() != 0 or end - start != timedelta(days=6) or len(names) != 2 or len(set(names)) != 2:
                raise ValueError(f'Invalid week or duty pair: {row}')
            if previous_end and start != previous_end + timedelta(days=1):
                raise ValueError(f'Discontinuous duty weeks: {row}')
            entries.append({'weekStart': start.isoformat(), 'endDate': end.isoformat(), 'assigneeNames': names, 'sourceRange': f'A{row}:D{row}'})
            last_month, previous_end = start_month, end
    return {'source': path.name, 'sheet': 'Sheet1', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'firstYear': first_year, 'weeks': entries}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--first-year', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = extract(args.workbook, args.first_year)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Extracted {len(result["weeks"])} weeks; {result["weeks"][0]["weekStart"]} to {result["weeks"][-1]["endDate"]}')
