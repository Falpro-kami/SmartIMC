const EMPTY_LOCATION = '__empty__';
const PAGE_SIZE = 20;
const STATUS_OPTIONS = [
  { value: '', label: '全部设备' }, { value: '闲置', label: '闲置' },
  { value: '正在使用', label: '正在使用' }, { value: '外借', label: '外借' }
];

function display(record) {
  const statusClass = { '闲置': 'idle', '正在使用': 'using', '外借': 'lent' }[record.status] || 'unknown';
  return Object.assign({}, record, {
    statusClass, statusLabel: record.status || '-', nameLabel: record.name || '-',
    equipmentNumberLabel: record.equipmentNumber || '-', modelLabel: record.model || '-',
    locationLabel: record.location || '-', userLabel: record.user || '-',
    imageUrl: typeof record.image === 'string' ? record.image.trim() : ''
  });
}

function buildView(records, filters, limit = PAGE_SIZE) {
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
  const matched = records.filter(record => {
    if (filters.status && record.status !== filters.status) return false;
    if (filters.location === EMPTY_LOCATION && record.location) return false;
    if (filters.location && filters.location !== EMPTY_LOCATION && record.location !== filters.location) return false;
    return !keyword || [record.name, record.equipmentNumber, record.inventoryNumber,
      record.model, record.user, record.location, record.custodian]
      .some(value => String(value || '').toLocaleLowerCase().includes(keyword));
  });
  const locations = Array.from(new Set(records.map(record => record.location || EMPTY_LOCATION)))
    .sort((a, b) => a === EMPTY_LOCATION ? 1 : b === EMPTY_LOCATION ? -1 : a.localeCompare(b));
  const statusValues = Array.from(new Set(STATUS_OPTIONS.map(item => item.value)
    .concat(records.map(record => record.status).filter(Boolean))));
  return {
    total: records.length,
    statusOptions: statusValues.map(value => ({ value, label: value || '全部设备',
      count: records.filter(record => !value || record.status === value).length })),
    locationOptions: [{ value: '', label: '全部位置' }].concat(locations.map(value =>
      ({ value, label: value === EMPTY_LOCATION ? '-' : value }))),
    visibleRecords: matched.slice(0, limit).map(display), filteredCount: matched.length,
    hasMore: matched.length > limit,
    hasFilters: !!(keyword || filters.status || filters.location),
    locationLabel: filters.location === EMPTY_LOCATION ? '-' : filters.location,
    filterCount: Number(!!filters.status) + Number(!!filters.location)
  };
}

module.exports = { buildView, display, PAGE_SIZE, EMPTY_LOCATION };
