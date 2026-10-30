import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolated = await mkdtemp(resolve(tmpdir(), 'bifrost-native-test-'));
const pluginDir = resolve(isolated, 'plugin');
await mkdir(pluginDir, { recursive: true });
for (const name of ['dist', 'package.json', 'openclaw.plugin.json']) {
  await cp(resolve(root, name), resolve(pluginDir, name), { recursive: true });
}
const stateDir = resolve(isolated, 'state');
await mkdir(stateDir, { recursive: true });
let data = [{ id: 'fixture/a' }, { id: 'fixture/b' }];
let status = 200;
const calls = [];
const server = createServer((req, res) => {
  assert.equal(req.url, '/v1/models');
  calls.push(req.headers.authorization);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { data } : { error: 'fixture unavailable' }));
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const configPath = resolve(stateDir, 'openclaw.json');
const legacy = { baseUrl, api: 'openai-completions', apiKey: 'sk-bf-legacy-fixture',
  models: [{ id: 'fixture/legacy', name: 'Legacy fixture' }] };
const cfg = {
  gateway: { mode: 'local' },
  agents: { defaults: { workspace: resolve(isolated, 'workspace') } },
  plugins: { allow: ['bifrost'], load: { paths: [pluginDir] }, entries: { bifrost: { enabled: true, config: { baseUrl } } } },
  models: { providers: { bifrost: legacy } },
};
await writeFile(configPath, JSON.stringify(cfg));
const logs = [];
async function command(args, key, provider) {
  const env = { PATH: process.env.PATH, TMPDIR: isolated, OPENCLAW_HOME: isolated,
    OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AGENT_DIR: resolve(stateDir, 'agents/main/agent'),
    OPENCLAW_NO_RESPAWN: '1', NO_COLOR: '1', BIFROST_FIXTURE_URL: baseUrl, ...(key ? { BIFROST_API_KEY: key } : {}) };
  const child = spawn(process.execPath, args, { cwd: isolated, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), 45000);
  const exitCode = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', accept); });
  clearTimeout(timeout);
  logs.push({ provider, exitCode, stdout, stderr });
  assert.equal(exitCode, 0, stdout + stderr);
  return provider === 'runtime-sdk'
    ? JSON.parse(stdout.split('\n').find((line) => line.startsWith('{"status":"PASS"')))
    : JSON.parse(stdout.slice(stdout.indexOf('{')));
}
async function list(key = 'sk-bf-native-a', provider = 'bifrost-live') {
  return command([resolve(root, 'node_modules/openclaw/openclaw.mjs'), 'models', 'list', '--all', '--refresh', '--provider', provider, '--json'], key, provider);
}
function keys(result) { return result.models.map((model) => model.key).sort(); }
try {
  const initial = await list();
  console.log('Initial native output:', JSON.stringify(initial));
  assert.deepEqual(keys(initial), ['bifrost-live/fixture/a', 'bifrost-live/fixture/b']);
  data = [{ id: 'fixture/c' }];
  assert.deepEqual(keys(await list()), ['bifrost-live/fixture/c']);
  data = [];
  assert.deepEqual(keys(await list()), []);
  status = 403;
  assert.deepEqual(keys(await list()), []);
  status = 500;
  assert.deepEqual(keys(await list()), []);
  status = 200; data = [{ id: 'fixture/new-key' }];
  const start = calls.length;
  assert.deepEqual(keys(await list('sk-bf-native-b')), ['bifrost-live/fixture/new-key']);
  assert.ok(calls.slice(start).length > 0); assert.ok(calls.slice(start).every((key) => key === 'Bearer sk-bf-native-b'));
  const beforeMissing = calls.length;
  assert.deepEqual(keys(await list('')), []);
  assert.equal(calls.length, beforeMissing);
  assert.deepEqual(keys(await list('sk-bf-native-b', 'bifrost')), ['bifrost/fixture/legacy']);
  const beforeRuntime = calls.length;
  const runtimeResult = await command([resolve(root, 'scripts/native-auth-smoke.mjs')], 'sk-bf-native-a', 'runtime-sdk');
  assert.equal(runtimeResult.status, 'PASS');
  assert.deepEqual(calls.slice(beforeRuntime), ['Bearer sk-bf-native-runtime-a', 'Bearer sk-bf-native-runtime-b', 'Bearer sk-bf-native-runtime-b', 'Bearer sk-bf-native-profile-a', 'Bearer sk-bf-native-profile-b']);
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(after.models.providers.bifrost, legacy);
  assert.deepEqual(after, cfg);
  console.log(JSON.stringify({ status: 'PASS', scenarios: 15, host: 'openclaw@2026.10.9', httpRequests: calls.length,
    assertions: ['initial discovery', 'add/remove', 'empty catalog', '403 revocation', '500 failure', 'key rotation', 'key removal', 'legacy coexistence/config unchanged', ...runtimeResult.assertions] }, null, 2));
} finally {
  server.closeAllConnections(); await new Promise((accept) => server.close(accept));
  await writeFile(resolve(isolated, 'native-cli-results.json'), JSON.stringify(logs, null, 2));
  console.log(`Isolated evidence: ${isolated}`);
}
