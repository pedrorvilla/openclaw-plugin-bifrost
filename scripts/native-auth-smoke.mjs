// Invoked only by native-smoke.mjs, with isolated OpenClaw paths and fake keys.
import assert from 'node:assert/strict';
import entry from '../dist/index.js';
import { upsertAuthProfileWithLock, removeProviderAuthProfilesWithLock } from 'openclaw/plugin-sdk/provider-auth';
import { readFile } from 'node:fs/promises';
const baseUrl = process.env.BIFROST_FIXTURE_URL;
assert.ok(baseUrl?.startsWith('http://127.0.0.1:'));
assert.ok(process.env.OPENCLAW_STATE_DIR?.includes('bifrost-native-test-'));
let provider;
entry.register({ registerProvider: (value) => { provider = value; }, logger: { warn: () => {} } });
const cfg = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
const ctx = { provider: 'bifrost-live', modelId: 'fixture/new-key', config: cfg,
  agentDir: process.env.OPENCLAW_AGENT_DIR, workspaceDir: process.env.OPENCLAW_HOME, modelRegistry: {} };
process.env.BIFROST_API_KEY = 'sk-bf-native-runtime-a';
assert.equal((await provider.prepareDynamicModel(ctx)).id, ctx.modelId);
process.env.BIFROST_API_KEY = 'sk-bf-native-runtime-b';
assert.equal((await provider.prepareDynamicModel(ctx)).id, ctx.modelId);
const auth = await provider.prepareRuntimeAuth({ ...ctx, model: { baseUrl }, env: process.env,
  apiKey: 'sk-bf-native-runtime-b', authMode: 'api-key' });
assert.equal(auth.apiKey, 'sk-bf-native-runtime-b');
delete process.env.BIFROST_API_KEY;
await assert.rejects(() => provider.prepareDynamicModel(ctx));
const profileId = 'bifrost-live:fixture';
const profileCtx = { ...ctx, authProfileId: profileId };
for (const key of ['sk-bf-native-profile-a', 'sk-bf-native-profile-b']) {
  const updated = await upsertAuthProfileWithLock({ profileId, agentDir: ctx.agentDir,
    credential: { type: 'api_key', provider: 'bifrost-live', key } });
  assert.ok(updated);
  assert.equal((await provider.prepareDynamicModel(profileCtx)).id, ctx.modelId);
}
assert.ok(await removeProviderAuthProfilesWithLock({ cfg, provider: 'bifrost-live', agentDir: ctx.agentDir, profileIds: [profileId] }));
await assert.rejects(() => provider.prepareDynamicModel(profileCtx));
console.log(JSON.stringify({ status: 'PASS', scenarios: 7, assertions: ['real SDK auth resolution', 'env rotation', 'actual inference key check', 'credential deletion', 'stored profile lookup', 'stored profile rotation', 'stored profile deletion'] }));
