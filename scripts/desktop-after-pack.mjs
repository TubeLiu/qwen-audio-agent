import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { feishuCliAsset } from '../shared/feishu-cli-assets.mjs'

// extraResources excludes its sources from app.asar, even if `files` includes
// them. This shared module is needed both inside the app and by external
// backend launchers, so copy the external instance after packing, before signing.
export default async function afterPack({ appOutDir, packager, electronPlatformName, arch }) {
  const { Arch } = await import('builder-util')
  const resources = packager.getResourcesDir(appOutDir)
  const target = join(resources, 'runtime/shared/runtime-paths.mjs')
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(packager.projectDir, 'shared/runtime-paths.mjs'), target)
  const targetArch = typeof arch === 'string' ? arch : Arch[arch]
  for (const slice of electronPlatformName === 'darwin' ? ['x64', 'arm64'] : [targetArch]) {
    const asset = feishuCliAsset(electronPlatformName, slice)
    const source = join(packager.projectDir, 'vendor/feishu-cli', asset.key)
    const destination = join(resources, 'runtime/feishu-cli', asset.key)
    await mkdir(destination, { recursive: true })
    for (const name of [asset.binary, 'metadata.json', 'LICENSE']) {
      await copyFile(join(source, name), join(destination, name))
    }
    if (electronPlatformName !== 'win32') await chmod(join(destination, asset.binary), 0o755)
  }
}
