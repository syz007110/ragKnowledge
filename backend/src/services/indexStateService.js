function countIndexedStates(states = [], { requireVectorSync = true } = {}) {
  return (states || []).filter((item) => {
    const esReady = String(item?.esStatus || '') === 'done';
    const vectorReady = String(item?.vectorStatus || '') === 'done';
    return esReady && (!requireVectorSync || vectorReady);
  }).length;
}

module.exports = {
  countIndexedStates
};
