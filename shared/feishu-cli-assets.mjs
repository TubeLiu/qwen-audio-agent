// Checksums published in @larksuite/cli 1.0.97. Desktop builds ship the native
// executable outside ASAR; no npm/global installation is needed at runtime.
export const FEISHU_CLI_VERSION = '1.0.97'
export const FEISHU_CLI_ASSETS = Object.freeze({
  'win32-x64': Object.freeze({ name: 'lark-cli-1.0.97-windows-amd64.zip', sha256: '88ee81ec73be12432b2297df010098b5069e5ff0403123e1cd308ad0061f1397' }),
  'win32-arm64': Object.freeze({ name: 'lark-cli-1.0.97-windows-arm64.zip', sha256: '4fef85e999fc54de1234b0bb622766f096870db2b86a396545e01a4156abfb3b' }),
  'darwin-x64': Object.freeze({ name: 'lark-cli-1.0.97-darwin-amd64.tar.gz', sha256: '1f5d3899138bc058662a027d0034ed69d21287d83322993afc01fee559b78de0' }),
  'darwin-arm64': Object.freeze({ name: 'lark-cli-1.0.97-darwin-arm64.tar.gz', sha256: '64e856a05c8dfdac5dbecd316766e4b05299f230f54833b674a623df3ac13f1c' }),
  'linux-x64': Object.freeze({ name: 'lark-cli-1.0.97-linux-amd64.tar.gz', sha256: '7ce11848724f0b0bc8204012140adbf76fe7c1fc8abd41c1878bc97b7228126b' }),
  'linux-arm64': Object.freeze({ name: 'lark-cli-1.0.97-linux-arm64.tar.gz', sha256: '2dec3e362ecce05b535854a0205035bb4ccdb72dbbed9a321890c2089da16bc5' }),
})

export function feishuCliAsset(platform, arch) {
  const key = `${platform}-${arch}`
  const asset = FEISHU_CLI_ASSETS[key]
  if (!asset) throw new Error(`飞书 CLI 尚未支持构建目标 ${key}。`)
  return { ...asset, key, platform, arch,
    binary: platform === 'win32' ? 'lark-cli.exe' : 'lark-cli',
    url: `https://github.com/larksuite/cli/releases/download/v${FEISHU_CLI_VERSION}/${asset.name}` }
}
