// Backward-compatible facade retained for older imports.
const engine = require('./workflow-engine');
module.exports = {
  scan: engine.scanActiveWorkflows,
  schedule: engine.schedule,
};
