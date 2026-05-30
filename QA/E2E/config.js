const fs = require('fs');
const path = require('path');

const localConfigPath = path.join(__dirname, 'e2e.config.local.json');

function readLocalConfig() {
  if (!fs.existsSync(localConfigPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid ${path.basename(localConfigPath)}: ${err.message}`);
  }
}

function loadE2eConfig() {
  const fileConfig = readLocalConfig();
  return {
    baseUrl: process.env.E2E_BASE_URL || fileConfig.baseUrl || '',
    adminToken: process.env.E2E_ADMIN_TOKEN || fileConfig.adminToken || '',
    gasRpcTimeoutMs: Number(process.env.E2E_GAS_RPC_TIMEOUT_MS || fileConfig.gasRpcTimeoutMs || 120000),
    fixtureVisibleTimeoutMs: Number(process.env.E2E_FIXTURE_VISIBLE_TIMEOUT_MS || fileConfig.fixtureVisibleTimeoutMs || 180000),
    fixturePollMs: Number(process.env.E2E_FIXTURE_POLL_MS || fileConfig.fixturePollMs || 3000),
    swalTimeoutMs: Number(process.env.E2E_SWAL_TIMEOUT_MS || fileConfig.swalTimeoutMs || 90000),
    googleScriptTimeoutMs: Number(process.env.E2E_GOOGLE_SCRIPT_TIMEOUT_MS || fileConfig.googleScriptTimeoutMs || 180000)
  };
}

module.exports = {
  loadE2eConfig
};
