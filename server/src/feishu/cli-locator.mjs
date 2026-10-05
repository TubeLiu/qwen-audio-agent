import { accessSync, constants, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feishuCliAsset } from '../../../shared/feishu-cli-assets.mjs'

const developmentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function nativeFile(path, platform) {
  try {
    if (!statSync(path).isFile()) return false
    if (platform === 'win32' && !path.toLowerCase().endsWith('.exe')) return false
    if (/\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path)) return false
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch { return false }
}

// Resolve a native executable only. Callers use spawn/execFile with shell:false;
// this lookup never installs, downloads, logs in, or changes user configuration.
export function resolveFeishuCli({
  explicitPath, platform = process.platform, arch = process.arch,
  env = process.env, resourcesPath = process.resourcesPath,
  sourceRoot = developmentRoot,
} = {}) {
  const configured = String(explicitPath || env.FEISHU_CLI_PATH || env.LARK_CLI_PATH || '').trim()
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('FEISHU_CLI_PATH 必须是飞书 CLI 原生可执行文件的绝对路径。')
    if (!nativeFile(configured, platform)) throw new Error('配置的飞书 CLI 原生可执行文件不可用，请检查 FEISHU_CLI_PATH。')
    return resolve(configured)
  }
  const asset = feishuCliAsset(platform, arch)
  const runtimeRoot = env.QWEN_AUDIO_AGENT_RUNTIME_ROOT
    || (resourcesPath ? resolve(resourcesPath, 'runtime') : '')
  if (runtimeRoot) {
    const bundled = resolve(runtimeRoot, 'feishu-cli', asset.key, asset.binary)
    if (nativeFile(bundled, platform)) return bundled
    throw new Error('安装包中的飞书 CLI 缺失或不可执行，请重新安装此 TubeLiu 版本，或设置 FEISHU_CLI_PATH。')
  }
  const local = resolve(sourceRoot, 'vendor/feishu-cli', asset.key, asset.binary)
  if (nativeFile(local, platform)) return local
  throw new Error('飞书 CLI 尚未准备：请在源码工程运行 node scripts/prepare-feishu-cli.mjs，或设置 FEISHU_CLI_PATH。')
}
