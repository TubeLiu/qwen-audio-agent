import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { FEISHU_CLI_ASSETS, feishuCliAsset } from '../shared/feishu-cli-assets.mjs'
import { forkConfigDirectory } from '../shared/fork-identity.mjs'
import { resolveFeishuCli } from '../server/src/feishu/cli-locator.mjs'
import { downloadVerifiedAsset, validateArchiveEntries } from '../scripts/prepare-feishu-cli.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-cli-resource-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('CLI resource selection covers both macOS slices and Windows without a global wrapper', t => {
  const root = fixture(t)
  for (const key of Object.keys(FEISHU_CLI_ASSETS)) {
    const [platform, arch] = key.split('-')
    const asset = feishuCliAsset(platform, arch)
    const directory = join(root, 'runtime/feishu-cli', key)
    mkdirSync(directory, { recursive: true })
    const binary = join(directory, asset.binary)
    writeFileSync(binary, 'native fixture')
    chmodSync(binary, 0o755)
    assert.equal(resolveFeishuCli({ platform, arch, env: {}, resourcesPath: root }), binary)
  }
  assert.throws(() => feishuCliAsset('darwin', 'ia32'), /尚未支持/)
})

test('bundled CLI failure cannot silently switch to another development binary; wrappers are refused', t => {
  const root = fixture(t)
  const dev = join(root, 'vendor/feishu-cli/win32-x64')
  mkdirSync(dev, { recursive: true })
  writeFileSync(join(dev, 'lark-cli.exe'), 'fixture')
  assert.throws(() => resolveFeishuCli({ platform: 'win32', arch: 'x64', env: { QWEN_AUDIO_AGENT_RUNTIME_ROOT: join(root, 'missing') }, sourceRoot: root }), /安装包/)
  assert.equal(resolveFeishuCli({ platform: 'win32', arch: 'x64', env: {}, sourceRoot: root }), join(dev, 'lark-cli.exe'))
  const wrapper = join(root, 'lark-cli.cmd')
  writeFileSync(wrapper, 'echo fixture')
  assert.throws(() => resolveFeishuCli({ explicitPath: wrapper, platform: 'win32', env: {} }), /原生/)
  assert.throws(() => resolveFeishuCli({ explicitPath: 'relative.exe', platform: 'win32', env: {} }), /绝对路径/)
})

test('official download bytes are verified and corrupt downloads never remain installed', async t => {
  const root = fixture(t)
  const bytes = Buffer.from('verified release fixture')
  const asset = { url: 'https://github.com/larksuite/cli/releases/fixture', sha256: createHash('sha256').update(bytes).digest('hex') }
  const file = join(root, 'download')
  await downloadVerifiedAsset(asset, file, { fetcher: async () => new Response(bytes) })
  assert.deepEqual(readFileSync(file), bytes)
  const corrupt = join(root, 'corrupt')
  await assert.rejects(downloadVerifiedAsset(asset, corrupt, { fetcher: async () => new Response('different bytes') }), /SHA256/)
  assert.throws(() => readFileSync(corrupt), /ENOENT/)
  await assert.rejects(downloadVerifiedAsset(asset, file, { fetcher: async () => new Response(bytes) }), /EEXIST/)
  assert.deepEqual(readFileSync(file), bytes, 'An existing file must survive an exclusive-write failure')
})

test('archive extraction refuses traversal and absolute paths', () => {
  for (const entry of ['../lark-cli', '/lark-cli', 'C:\\lark-cli', 'nested/../../lark-cli']) {
    assert.throws(() => validateArchiveEntries([entry]), /越界/)
  }
  assert.doesNotThrow(() => validateArchiveEntries(['./lark-cli', 'LICENSE']))
})

test('fork data defaults are isolated and explicit user paths remain authoritative', () => {
  assert.equal(forkConfigDirectory({}, '/user'), resolve('/user/.config/qwaudio-tubeliu'))
  assert.equal(forkConfigDirectory({ QWAUDIO_CONFIG_DIR: '/explicit' }, '/user'), resolve('/explicit'))
  assert.equal(forkConfigDirectory({ XDG_CONFIG_HOME: '/xdg' }, '/user'), resolve('/xdg/qwaudio-tubeliu'))
})
