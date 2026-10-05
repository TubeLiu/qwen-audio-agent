import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { redact } from './config.mjs';

export class CliError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'CliError'; this.details = details; }
}

export function spawnCli(file, args, { timeoutMs = 45000, maxBytes = 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', bytes = 0, terminal = false;
    const timer = setTimeout(() => { terminal = true; child.kill(); reject(new CliError('飞书操作超时；如果是写入，请先在飞书核对结果再发起新命令。')); }, timeoutMs);
    const collect = (target, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes && !terminal) { terminal = true; child.kill(); clearTimeout(timer); reject(new CliError('飞书返回内容过大，请缩小查询范围。')); }
      if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => { clearTimeout(timer); if (!terminal) reject(new CliError(`飞书 CLI 无法启动：${error.code || error.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (!terminal) resolve({ code, stdout, stderr }); });
  });
}

function parseJson(text) {
  try { return JSON.parse(text.trim()); } catch { return null; }
}

export function interpretCliResult(result, config = {}) {
  const output = parseJson(result.stdout);
  const errorOutput = parseJson(result.stderr);
  if (result.code === 0 && output?.ok === true) return output.data;
  const error = errorOutput?.error || output?.error;
  if (error) throw new CliError(redact(config, error.message || '飞书拒绝了操作。'), {
    type: error.type, subtype: error.subtype, code: error.code,
    hint: redact(config, error.hint || ''), missingScopes: error.missing_scopes || [],
    confirmationRequired: result.code === 10 && error.type === 'confirmation',
  });
  throw new CliError(redact(config, result.code === 0 ? '飞书 CLI 没有返回可验证的成功结果。' : `飞书 CLI 执行失败（退出码 ${result.code}）。`));
}

export class FeishuCli {
  constructor(config, runner = spawnCli) { this.config = config; this.runner = runner; this.authCache = null; }
  async execute(args) {
    const result = await this.runner(this.config.cliPath, args, { timeoutMs: this.config.cliTimeoutMs });
    return interpretCliResult(result, this.config);
  }
  async authStatus({ fresh = false } = {}) {
    if (!fresh && this.authCache && Date.now() - this.authCache.timestamp < 15000) return this.authCache.value;
    if (!existsSync(this.config.cliPath) && this.runner === spawnCli) return { installed: false, available: false, status: 'cli_missing' };
    try {
      const result = await this.runner(this.config.cliPath, ['auth', 'status', '--json', '--verify'], { timeoutMs: 12000 });
      const data = parseJson(result.stdout);
      if (result.code !== 0 || !data?.identities) throw new Error('auth_status_failed');
      const user = data.identities.user || {};
      const value = { installed: true, available: user.available === true, verified: user.verified === true || data.verified === true, status: user.status || 'unknown', openId: user.openId || '', appConfigured: Boolean(data.appId) };
      this.authCache = { timestamp: Date.now(), value };
      return value;
    } catch { return { installed: true, available: false, status: 'unavailable' }; }
  }
  async loginStart() {
    const result = await this.runner(this.config.cliPath, ['auth', 'login', '--domain', 'docs,drive,im,calendar,base,task', '--scope', 'im:message.send_as_user', '--no-wait', '--json'], { timeoutMs: 15000 });
    const output = parseJson(result.stdout);
    if (result.code !== 0) return interpretCliResult(result, this.config);
    const data = output?.data || output;
    if (!data?.verification_url || !data?.device_code) throw new CliError('飞书未返回授权链接，请先运行 lark-cli config init --new。');
    return { url: data.verification_url, deviceCode: data.device_code };
  }
  async loginComplete(deviceCode) {
    const result = await this.runner(this.config.cliPath, ['auth', 'login', '--device-code', deviceCode, '--json'], { timeoutMs: 15000 });
    if (result.code !== 0) interpretCliResult(result, this.config);
    this.authCache = null;
    return this.authStatus({ fresh: true });
  }
}
