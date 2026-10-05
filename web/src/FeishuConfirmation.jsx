import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gatewayFetch } from './gateway-transport.js'
import './feishu-confirmation.css'

export default function FeishuConfirmation({ task }) {
  const planId = task.inputRequest?.id
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [seenAll, setSeenAll] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const previewRef = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    setPlan(null); setSeenAll(false); setReviewed(false); setError('')
    gatewayFetch(`/api/feishu/plans/${encodeURIComponent(planId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const value = await response.json()
        if (!response.ok) throw new Error(value.error || '无法读取飞书预览。')
        if (!controller.signal.aborted) setPlan(value)
      }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [planId])
  useLayoutEffect(() => {
    const element = previewRef.current
    if (element && element.scrollHeight <= element.clientHeight + 4) setSeenAll(true)
  }, [plan])
  async function decide(action) {
    setBusy(true); setError('')
    try {
      const response = await gatewayFetch(`/api/feishu/plans/${encodeURIComponent(planId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, reviewed, reviewToken: plan?.reviewToken }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '飞书操作未提交。')
      setPlan(current => ({ ...current, status: 'done', text: result.text || '已取消本次操作。' }))
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <section className="feishu-confirmation" aria-label="飞书本次操作确认" aria-busy={busy}>
    <strong>飞书操作等待本次确认</strong>
    {!plan && !error && <p role="status">正在读取完整预览…</p>}
    {plan?.status === 'confirmation' && <>
      <p>核对目标、内容与影响。请滚动查看全文，再勾选并点击确认。语音中的“好的”和“始终允许”不会执行这项操作。</p>
      <pre ref={previewRef} tabIndex={0} aria-label="完整操作预览" onScroll={event => {
        const element = event.currentTarget
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 4) setSeenAll(true)
      }}>{plan.preview}</pre>
      <label><input type="checkbox" checked={reviewed} disabled={!seenAll || busy}
        onChange={event => setReviewed(event.target.checked)} />我已核对本次完整预览</label>
      <div>
        <button type="button" disabled={!reviewed || busy} onClick={() => decide('confirm')}>确认执行本次操作</button>
        <button type="button" disabled={busy} onClick={() => decide('cancel')}>取消</button>
      </div>
    </>}
    {plan && plan.status !== 'confirmation' && <p role="status">{plan.text}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
