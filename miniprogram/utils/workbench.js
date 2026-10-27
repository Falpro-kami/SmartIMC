function rankTools(tools, usage = {}, limit = 4) {
  function stat(id) {
    const value = usage && usage[id] || {};
    return { count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0,
      lastOpenedMs: Number.isSafeInteger(value.lastOpenedMs) && value.lastOpenedMs >= 0 ? value.lastOpenedMs : 0 };
  }
  return tools.map((tool, index) => ({ tool, index, stats: stat(tool.id) }))
    .sort((a, b) => b.stats.count - a.stats.count || b.stats.lastOpenedMs - a.stats.lastOpenedMs || a.index - b.index)
    .slice(0, limit).map(value => value.tool);
}
module.exports = { rankTools };
