import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('builds and uploads both install and automatic-update macOS artifacts', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

  assert.match(builder, /target:\s*\n\s*- dmg\s*\n\s*- zip/)
  assert.match(manifest.scripts['desktop:build'], /--mac dmg zip/)
  assert.match(workflow, /dist\/desktop\/\*\.dmg/)
  assert.match(workflow, /dist\/desktop\/\*\.zip/)
})

test('copies only backend runtime scripts outside the desktop archive', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const scriptsResource = builder.match(
    /  - from: scripts\r?\n[\s\S]*?(?=\r?\n  - from:|$)/,
  )?.[0]
  assert.ok(scriptsResource)
  assert.match(scriptsResource, /- "runtime\/\*\*\/\*"/)
  assert.doesNotMatch(scriptsResource, /- "\*\*\/\*"/)
})

test('fork installers, updater and native deep links do not replace the upstream app', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const main = readFileSync(new URL('desktop/src/main.mjs', root), 'utf8')
  assert.match(builder, /appId: ai\.qwenaudio\.agent\.tubeliu\r?\n/)
  assert.match(builder, /productName: Qwen Audio Agent TubeLiu/)
  assert.match(builder, /name: qwen-audio-agent-tubeliu\r?\n/)
  assert.match(builder, /owner: TubeLiu/)
  assert.doesNotMatch(builder, /owner: QwenAudio/)
  assert.match(builder, /- qwaudio-tubeliu/)
  assert.match(builder, /beforePack: scripts\/prepare-feishu-cli\.mjs/)
  assert.match(builder, /x64ArchFiles: Contents\/Resources\/runtime\/feishu-cli\/darwin-\*\/lark-cli/)
  const packHook = readFileSync(new URL('scripts/desktop-after-pack.mjs', root), 'utf8')
  assert.match(packHook, /runtime\/feishu-cli/)
  assert.match(packHook, /\['x64', 'arm64'\]/)
  assert.match(main, /app\.setPath\('userData', resolve\(app\.getPath\('appData'\), 'Qwen Audio Agent TubeLiu'\)\)/)
  assert.match(main, /process\.env\.QWAUDIO_CONFIG_DIR = forkConfigDirectory\(\)/)
  assert.doesNotMatch(main, /setAsDefaultProtocolClient\('qwaudio'/)
})
