import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronRoot = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
// Spawn the installed native binary on Windows as well as macOS/Linux. A .cmd
// wrapper requires a shell and cannot be passed to spawn with shell:false.
const executable = resolve(
  electronRoot, 'dist', readFileSync(resolve(electronRoot, 'path.txt'), 'utf8').trim(),
)
const fixture = resolve(root, 'desktop/smoke/electron-smoke.cjs')
const scratch = mkdtempSync(join(tmpdir(), 'qwa-electron-smoke-'))

const child = spawn(executable, [fixture], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    QWEN_SMOKE_USER_DATA_DIR: scratch,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })
const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
const [code, signal] = await new Promise(resolvePromise => {
  child.once('error', error => {
    stderr += error.stack || error.message
    resolvePromise([1, null])
  })
  child.once('exit', (...result) => resolvePromise(result))
})
clearTimeout(timer)
rmSync(scratch, { recursive: true, force: true })
if (code !== 0 || !stdout.includes('QWEN_AUDIO_DESKTOP_SMOKE_OK')) {
  throw new Error(
    `Electron desktop smoke test failed (${signal || code})\n${stdout}\n${stderr}`,
  )
}
process.stdout.write('Electron desktop smoke test passed.\n')
