import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FEISHU_CLI_VERSION, feishuCliAsset } from '../shared/feishu-cli-assets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024

export async function sha256File(path) {
  const digest = createHash('sha256')
  for await (const part of createReadStream(path)) digest.update(part)
  return digest.digest('hex')
}

export function validateArchiveEntries(entries) {
  if (!entries.length || entries.length > 500) throw new Error('飞书 CLI 压缩包目录无效。')
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (isAbsolute(entry) || /^[a-z]:/i.test(entry) || normalized.startsWith('/')
      || normalized.split('/').includes('..') || normalized.includes('\0')) {
      throw new Error('飞书 CLI 压缩包包含越界路径。')
    }
  }
}

export async function downloadVerifiedAsset(asset, destination, { fetcher = fetch } = {}) {
  const response = await fetcher(asset.url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`官方飞书 CLI 下载失败 (${response.status})。`)
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) throw new Error('飞书 CLI 下载包过大。')
  const digest = createHash('sha256')
  let bytes = 0
  let created = false
  const target = createWriteStream(destination, { flags: 'wx' })
  target.once('open', () => { created = true })
  try {
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const part of source) {
        bytes += part.length
        if (bytes > MAX_ARCHIVE_BYTES) throw new Error('飞书 CLI 下载包超过大小上限。')
        digest.update(part)
        yield part
      }
    }, target)
    if (digest.digest('hex') !== asset.sha256) throw new Error('官方飞书 CLI SHA256 校验失败，未安装该文件。')
  } catch (error) {
    if (created) await rm(destination, { force: true })
    throw error
  }
}

function archiveCommand(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('无法解压已校验的飞书 CLI：请安装系统 tar，并重新运行准备脚本。')
  return result.stdout.trim()
}

export async function prepareFeishuCli({ platform = process.platform, arch = process.arch, root = projectRoot } = {}) {
  const asset = feishuCliAsset(platform, arch)
  const output = resolve(root, 'vendor/feishu-cli', asset.key)
  const binary = resolve(output, asset.binary)
  const metadataPath = resolve(output, 'metadata.json')
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (metadata.version === FEISHU_CLI_VERSION && metadata.assetSha256 === asset.sha256
      && metadata.platform === platform && metadata.arch === arch
      && metadata.binarySha256 === await sha256File(binary)) {
      if (platform !== 'win32') await chmod(binary, 0o755)
      return binary
    }
  } catch { /* Missing or changed cache is rebuilt from the verified archive. */ }
  const cache = resolve(root, '.cache/feishu-cli')
  await mkdir(cache, { recursive: true })
  const archive = resolve(cache, asset.name)
  let verified = false
  try { verified = (await stat(archive)).isFile() && await sha256File(archive) === asset.sha256 } catch { /* Download below. */ }
  if (!verified) {
    const temporary = resolve(cache, `${asset.name}.${process.pid}.download`)
    await rm(temporary, { force: true })
    await downloadVerifiedAsset(asset, temporary)
    await rename(temporary, archive)
  }
  const scratch = await mkdtemp(resolve(cache, '.unpack-'))
  try {
    const entries = archiveCommand(['-tf', archive]).split(/\r?\n/).filter(Boolean)
    validateArchiveEntries(entries)
    const entry = entries.find(name => name.replace(/^\.\//, '') === asset.binary)
    if (!entry) throw new Error('官方飞书 CLI 包未包含预期的原生可执行文件。')
    const license = entries.find(name => /^LICENSE(?:\.txt)?$/i.test(name.replace(/^\.\//, '')))
    archiveCommand(['-xf', archive, '-C', scratch, entry, ...(license ? [license] : [])])
    const extracted = resolve(scratch, asset.binary)
    if (!(await stat(extracted)).isFile()) throw new Error('飞书 CLI 解压结果不是原生文件。')
    await mkdir(output, { recursive: true })
    await copyFile(extracted, binary)
    if (platform !== 'win32') await chmod(binary, 0o755)
    if (license) await copyFile(resolve(scratch, license), resolve(output, 'LICENSE'))
    await writeFile(metadataPath, JSON.stringify({ version: FEISHU_CLI_VERSION, platform, arch,
      asset: asset.name, assetSha256: asset.sha256, binarySha256: await sha256File(binary),
      source: asset.url, license: 'MIT' }, null, 2) + '\n')
    console.log(`Verified official Feishu CLI ${FEISHU_CLI_VERSION}: ${asset.key}`)
    return binary
  } finally {
    const contained = relative(cache, scratch)
    if (contained && !contained.startsWith('..') && !isAbsolute(contained)) await rm(scratch, { recursive: true, force: true })
  }
}

// electron-builder invokes this for the requested target, independently of the
// build host. Both macOS slices are shipped for universal builds.
export default async function beforePack(context) {
  const { Arch } = await import('builder-util')
  const platform = context.electronPlatformName
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch]
  const root = context.packager.projectDir
  for (const target of platform === 'darwin' ? ['x64', 'arm64'] : [arch]) {
    await prepareFeishuCli({ platform, arch: target, root })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const platform = option('--platform') || process.platform
  const targets = option('--arch') === 'universal' ? ['x64', 'arm64'] : [option('--arch') || process.arch]
  for (const arch of targets) await prepareFeishuCli({ platform, arch })
}
