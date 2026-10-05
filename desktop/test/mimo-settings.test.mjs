import assert from 'node:assert/strict'
import test from 'node:test'
import { REALTIME_PROVIDERS, realtimeSettingsValues, realtimeSettingsProfileState, realtimeSettingsFromProfileState } from '../../shared/realtime-provider-definitions.mjs'
import { gatewaySetupStatus } from '../../shared/gateway/setup.mjs'
import { parseSettings, normalizeSettings, realtimeSettingsConfigured, realtimeSettingsConfiguration, updateSettingsContent, applySettingsEnvironment } from '../src/settings-config.mjs'
import { realtimeSettingsFields } from '../src/realtime-settings-form.mjs'
import { desktopGatewayCompatibility } from '../src/gateway-process.mjs'

const provider = REALTIME_PROVIDERS.find(provider => provider.key === 'mimo')
const settings = realtimeSettingsValues({ realtimeProvider: 'mimo', mimoApiKey: 'chat', mimoAsrApiKey: 'asr', mimoTtsApiKey: 'tts' })

test('MiMo has ten independent editable bindings and lossless inactive drafts', () => {
  const fields = realtimeSettingsFields(provider, settings)
  assert.equal(fields.length, 10)
  assert.equal(new Set(fields.map(field => field.key)).size, 10)
  assert.ok(fields.find(field => field.key === 'mimoChatModel').editable)
  const drafts = { ...settings, mimoAsrBaseUrl: 'https://asr.example/v1', mimoTtsBaseUrl: 'https://tts.example/custom/v1' }
  assert.deepEqual(realtimeSettingsFromProfileState(realtimeSettingsProfileState(drafts)), drafts)
  assert.equal(drafts.mimoBaseUrl, 'https://token-plan-cn.xiaomimimo.com/v1')
})

test('MiMo configuration preserves each full HTTP path and does not reroute TokenPlan', () => {
  const value = normalizeSettings({ ...settings, dashscopeApiKey: 'existing', mimoAsrBaseUrl: 'https://asr.example/path/v1/' })
  assert.equal(value.mimoAsrBaseUrl, 'https://asr.example/path/v1')
  assert.equal(value.mimoBaseUrl, 'https://token-plan-cn.xiaomimimo.com/v1')
  const content = updateSettingsContent('DASHSCOPE_API_KEY=existing\n', value)
  const restored = parseSettings(content)
  assert.equal(restored.mimoAsrApiKey, 'asr')
  assert.equal(restored.mimoTtsApiKey, 'tts')
  assert.equal(restored.mimoApiKey, 'chat')
  assert.equal(restored.dashscopeApiKey, 'existing')
  assert.equal(restored.mimoAsrBaseUrl, value.mimoAsrBaseUrl)
  assert.equal(realtimeSettingsConfigured(restored), true)
  assert.throws(() => normalizeSettings({ ...settings, mimoTtsBaseUrl: 'wss://tts.example/v1' }), /HTTP/)
  assert.throws(() => normalizeSettings({ ...settings, mimoAsrBaseUrl: 'https://secret@asr.example/v1' }), /用户名/)
})

test('MiMo setup reports every missing key and partial configuration cannot start', () => {
  const env = applySettingsEnvironment({ ...settings, mimoAsrApiKey: '', mimoTtsApiKey: '' }, {})
  const status = gatewaySetupStatus(env)
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing.map(field => field.key), ['MIMO_ASR_API_KEY', 'MIMO_TTS_API_KEY'])
  assert.equal(realtimeSettingsConfigured({ ...settings, mimoTtsApiKey: '' }), false)
})

test('changing any MiMo service invalidates Gateway reuse without changing other providers', () => {
  const active = realtimeSettingsConfiguration(settings).active
  const health = { realtimeProvider: 'mimo', realtimeModel: active.model, realtimeConfigurationSignature: active.signature, backend: { enabled: false } }
  const env = applySettingsEnvironment(settings, {})
  assert.equal(desktopGatewayCompatibility(health, env).compatible, true)
  for (const field of provider.settings) {
    const modified = { ...settings, [field.key]: field.type === 'url' ? 'https://changed.example/v1' : 'changed-' + field.key }
    assert.notEqual(realtimeSettingsConfiguration(modified).active.signature, active.signature, field.key)
  }
  assert.equal(realtimeSettingsConfiguration({ ...settings, dashscopeApiKey: 'irrelevant' }).active.signature, active.signature)
})
