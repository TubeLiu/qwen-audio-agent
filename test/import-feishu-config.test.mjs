import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importFeishuAssistantConfig, legacyMiMoSettings } from '../scripts/import-feishu-assistant-config.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'

test('legacy migration keeps explicit provider addresses and never copies the chat key into TTS', () => {
  const settings = legacyMiMoSettings({ API_BASE_URL: 'https://chat.example/v1', API_KEY: 'private-chat', STT_BASE_URL: 'https://asr.example/v1', STT_API_KEY: 'private-asr', TTS_BASE_URL: 'https://tts.example/v1', TTS_API_KEY: 'private-tts' })
  assert.equal(settings.mimoBaseUrl, 'https://chat.example/v1')
  assert.equal(settings.mimoAsrApiKey, 'private-asr')
  assert.equal(settings.mimoTtsApiKey, 'private-tts')
  assert.equal(legacyMiMoSettings({ API_KEY: 'private-chat' }).mimoTtsApiKey, '')
})

test('legacy migration writes native private settings, preserves the source and refuses replacing an existing MiMo profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-config-import-'))
  const source = join(root, 'previous.env'), configDir = join(root, 'config'), clientDir = join(root, 'client')
  const original = 'API_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1\nAPI_KEY=private-chat\nSTT_API_KEY=private-asr\nTTS_API_KEY=private-tts\n'
  writeFileSync(source, original)
  try {
    importFeishuAssistantConfig({ source, configDir, clientDir, port: 18900 })
    const values = createSettingsStore({ configDir, clientDir, env: {} }).load()
    assert.equal(values.realtimeProvider, 'mimo')
    assert.equal(values.mimoApiKey, 'private-chat')
    assert.equal(values.mimoAsrApiKey, 'private-asr')
    assert.equal(values.mimoTtsApiKey, 'private-tts')
    assert.equal(values.gatewayUrl, 'http://127.0.0.1:18900')
    assert.equal(readFileSync(source, 'utf8'), original)
    assert.throws(() => importFeishuAssistantConfig({ source, configDir, clientDir }), /preserved/)
    assert.equal(createSettingsStore({ configDir, clientDir, env: {} }).load().mimoApiKey, 'private-chat')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
