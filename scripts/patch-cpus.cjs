// Ensures os.cpus() never returns an empty list.
// @vscode/vsce's secret scanner crashes when length is 0 (concurrency: 0).
'use strict';
const os = require('os');
const real = os.cpus.bind(os);
os.cpus = function patchedCpus() {
  const list = real();
  if (list && list.length > 0) {
    return list;
  }
  return [
    { model: 'cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }
  ];
};
