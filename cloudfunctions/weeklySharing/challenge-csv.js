const { TextDecoder } = require('node:util');
const { normalized, reject } = require('./challenge-policy');
function parse(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { try { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch (_) { reject('INVALID_CSV', 'CSV需使用UTF-8或GB18030编码。'); } }
  text = text.replace(/^\uFEFF/, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) reject('INVALID_CSV', 'CSV包含无效字符。');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { if (cell.length > 200) reject('INVALID_CSV', '单元格不能超过200字。'); row.push(cell.trim()); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(value => value)) rows.push(row); row = []; if (rows.length > 1001) reject('INVALID_CSV', 'CSV最多包含1000条成绩。'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === ',' || c === '\n' || c === '\r') { if (c === ',') pushCell(); else { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); } }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed) reject('INVALID_CSV', 'CSV引号后存在无效内容。'); cell += c; }
  }
  if (quoted) reject('INVALID_CSV', 'CSV引号未闭合。');
  if (cell || row.length || closed) pushRow();
  const headers = rows.shift() || [];
  if (headers.length < 3 || headers.length > 20 || headers.some(value => !value) || new Set(headers).size !== headers.length) reject('INVALID_CSV', 'CSV需包含组名、总分、位次，可添加评分明细列。');
  const group = headers.indexOf('组名'), rank = headers.indexOf('位次'), score = headers.findIndex(value => ['总分', '得分', '评分'].includes(value));
  if (group < 0 || rank < 0 || score < 0 || !rows.length) reject('INVALID_CSV', 'CSV必须包含组名、总分（或得分/评分）、位次。');
  if (headers.some(value => /^[=+@-]/.test(value))) reject('INVALID_CSV', '表头不能包含公式。');
  const entries = rows.map(values => {
    if (values.length !== headers.length || values.some(value => /^[=+@]/.test(value) || /^-/.test(value) && !/^-\d+(\.\d+)?$/.test(value))) reject('INVALID_CSV', 'CSV列数不一致或包含公式。');
    const scoreValue = Number(values[score]), rankValue = Number(values[rank]);
    if (!values[group] || !values[score] || !Number.isFinite(scoreValue) || Math.abs(scoreValue) > 1e9 || !/^[1-9]\d*$/.test(values[rank]) || rankValue > 1000) reject('INVALID_CSV', '评分须为数字，位次须为正整数。');
    return { groupName: values[group], key: normalized(values[group]), score: scoreValue, rank: rankValue, values };
  });
  if (new Set(entries.map(row => row.key)).size !== entries.length) reject('INVALID_CSV', 'CSV中存在重复组名。');
  return { headers, entries };
}
module.exports = { parse };
