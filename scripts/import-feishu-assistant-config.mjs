import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { forkConfigDirectory } from '../shared/fork-identity.mjs'

export function legacyMiMoSettings(values) {
  return {
    realtimeProvider: 'mimo',
    mimoBaseUrl: values.API_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
    mimoApiKey: values.API_KEY || '', mimoChatModel: values.CHAT_MODEL || 'mimo-v2.6-flash',
    mimoAsrBaseUrl: values.STT_BASE_URL || values.API_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
    mimoAsrApiKey: values.STT_API_KEY || values.API_KEY || '', mimoAsrModel: values.STT_MODEL || 'mimo-v2.5-asr',
    mimoTtsBaseUrl: values.TTS_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
    mimoTtsApiKey: values.TTS_API_KEY || '', mimoTtsModel: values.TTS_MODEL || 'mimo-v2.5-tts',
    mimoTtsVoice: values.TTS_VOICE || 'mimo_default',
  }
}

export function importFeishuAssistantConfig({ source, configDir = forkConfigDirectory(), clientDir = configDir, port = 18900 } = {}) {
  if (!source) throw new Error('Specify the previous local .env file with --source.')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid local Gateway port.')
  const values = parseEnv(readFileSync(resolve(source), 'utf8'))
  const imported = legacyMiMoSettings(values)
  if (!imported.mimoApiKey || !imported.mimoAsrApiKey || !imported.mimoTtsApiKey) throw new Error('The previous configuration needs independent chat, recognition and speech credentials.')
  const store = createSettingsStore({ configDir: resolve(configDir), clientDir: resolve(clientDir), env: {} })
  const previous = store.load()
  if (previous.mimoApiKey || previous.mimoAsrApiKey || previous.mimoTtsApiKey) throw new Error('The fork already has MiMo credentials; its settings were preserved.')
  store.save({ ...previous, ...imported, gatewayUrl: `http://127.0.0.1:${port}` })
  return { imported: true, configDirectory: resolve(configDir), gatewayUrl: `http://127.0.0.1:${port}` }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, 'config-dir': { type: 'string' }, 'client-dir': { type: 'string' }, port: { type: 'string' } } })
    const result = importFeishuAssistantConfig({ source: values.source, configDir: values['config-dir'], clientDir: values['client-dir'], port: Number(values.port || 18900) })
    process.stdout.write(`Configuration imported privately. Gateway: ${result.gatewayUrl}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
