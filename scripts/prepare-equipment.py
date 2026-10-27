"""Read the source workbook without modifying it; keep the import outside the app bundle."""
import argparse
from collections import Counter
from datetime import date, datetime
from hashlib import sha256
import json
from pathlib import Path

from openpyxl import load_workbook

FIELDS = {
    '序号': 'sequence', '设备编号': 'equipmentNumber', '设备名称': 'name',
    '编号': 'inventoryNumber', '设备型号': 'model', '使用情况': 'status',
    '使用人': 'user', '存放地': 'location', '责任人': 'custodian',
    '登记日期': 'registeredDate', '盘点日期': 'checkedDate',
    '设备图片': 'image', '情况说明': 'notes',
}


def text(cell):
    value = cell.value
    if value is None:
        return ''
    if isinstance(value, (datetime, date)):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, (int, float)) and value == int(value):
        # Preserve leading zeroes when identifiers are stored with a zero mask.
        mask = cell.number_format
        if mask and set(mask) == {'0'}:
            return str(int(value)).zfill(len(mask))
        return str(int(value))
    return str(value).strip()


def extract(source):
    workbook = load_workbook(source, data_only=True)
    records, skipped, excluded_ids = [], [], []
    incomplete = 0
    for sheet in workbook:
        headers = [cell.value for cell in sheet[1]]
        if not {'设备名称', '编号', '使用情况'}.issubset(headers):
            raise ValueError(f'Unrecognized sheet: {sheet.title}')
        ledger = 'unregistered' if sheet.title.startswith('未建账') else 'registered'
        for row in sheet.iter_rows(min_row=2):
            raw = dict(zip(headers, row))
            record = {key: text(raw[label]) if label in raw else '' for label, key in FIELDS.items()}
            if ledger == 'unregistered':
                if record['name'] or record['equipmentNumber']:
                    identity = ledger + ':' + (record['inventoryNumber'] or record['equipmentNumber'])
                    excluded_ids.append('eq_' + sha256(identity.encode()).hexdigest()[:24])
                continue
            if not record['name'] and not record['equipmentNumber']:
                if not record['inventoryNumber']:
                    skipped.append({'sheet': sheet.title, 'row': row[0].row})
                    continue
                # Keep the two number-only rows as requested; missing values stay empty.
                incomplete += 1
            if record['image']:
                raise ValueError('Image references require an explicit upload/mapping step.')
            # Inventory numbers overlap BETWEEN sheets, so include the ledger in the key.
            identity = ledger + ':' + (record['inventoryNumber'] or record['equipmentNumber'])
            if identity.endswith(':'):
                raise ValueError(f'Missing stable identity: {sheet.title}!{row[0].row}')
            record.update(_id='eq_' + sha256(identity.encode()).hexdigest()[:24],
                          ledger=ledger, sortOrder=len(records),
                          sourceSheet=sheet.title, sourceRow=row[0].row,
                          sourceFile=source.name, sourceHash=sha256(source.read_bytes()).hexdigest())
            records.append(record)
    if len({r['_id'] for r in records}) != len(records):
        raise ValueError('Duplicate inventory identity within a sheet; import stopped.')
    report = {'source': str(source), 'records': len(records), 'skippedEmptyRows': len(skipped),
              'incompleteRecords': incomplete, 'excludedUnregisteredIds': excluded_ids,
              'ledgers': dict(Counter(r['ledger'] for r in records)),
              'statuses': dict(Counter(r['status'] for r in records)), 'skipped': skipped}
    return records, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path('.local/equipment-import.json'))
    args = parser.parse_args()
    records, report = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    args.output.with_name('equipment-import-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'skipped'}, ensure_ascii=False))
