export function createFeishuSettingsForm({ root, api, translate = text => text } = {}) {
  if (!root || !api?.loadFeishuStatus) return null
  const status = root.querySelector('[data-feishu-status]')
  const connect = root.querySelector('[data-feishu-connect]')
  const refresh = root.querySelector('[data-feishu-refresh]')
  const complete = root.querySelector('[data-feishu-complete]')
  let attemptId = '', busy = false
  const show = text => { status.textContent = translate(text) }
  const run = async action => {
    if (busy) return
    busy = true
    for (const button of [connect, refresh, complete]) button.disabled = true
    try { await action() }
    catch (error) { show(error.message || '飞书连接未完成，请重试。') }
    finally {
      busy = false
      for (const button of [connect, refresh, complete]) button.disabled = false
    }
  }
  const render = payload => {
    const auth = payload?.auth || payload || {}
    if (payload?.enabled === false) show('当前 Gateway 尚未启用飞书功能。')
    else if (auth.ready) {
      show('飞书已连接')
      attemptId = ''
      complete.hidden = true
    } else show(auth.installed === false ? '请安装随客户端提供的飞书 CLI。' : '尚未连接飞书')
  }
  const load = () => run(async () => {
    show('正在检查飞书连接…')
    render(await api.loadFeishuStatus())
  })
  refresh.addEventListener('click', load)
  connect.addEventListener('click', () => run(async () => {
    show('正在连接飞书…')
    const result = await api.startFeishuLogin()
    if (result.ready) { render(result.auth || result); return }
    if (!result.attemptId || !result.url) throw new Error('飞书没有返回授权地址，请重试。')
    attemptId = result.attemptId
    complete.hidden = false
    show('请在浏览器完成授权，然后点击“授权完成”。')
  }))
  complete.addEventListener('click', () => run(async () => {
    show('正在验证飞书授权…')
    render(await api.completeFeishuLogin(attemptId))
  }))
  return { load }
}
