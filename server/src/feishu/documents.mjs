import { CliError } from './cli.mjs'

// Plain text is always encoded inside our own documented DocxXML blocks.
// Neither model markup, local @file references nor remote resources are parsed.
const xmlText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
export function documentBody(content) {
  return `<p>${xmlText(content).replace(/\r\n?|\n/g, '<br/>')}</p>`
}
export function newDocumentBody(title, content) {
  return `<title>${xmlText(title)}</title>${documentBody(content)}`
}

export function documentReference(value) {
  if (typeof value !== 'string') return null
  if (/^[A-Za-z0-9]{10,150}$/.test(value)) return { token: value, value }
  try {
    const url = new URL(value)
    const path = url.pathname.match(/^\/(docx|wiki)\/([A-Za-z0-9]{10,150})\/?$/)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !path
      || !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)) return null
    url.search = ''; url.hash = ''
    return { token: path[2], type: path[1], value: url.href, url: url.href }
  } catch { return null }
}

export function rememberDocument(session, reference) {
  if (!reference) return
  if (reference.url || !session.knownDocs.has(reference.token)) session.knownDocs.set(reference.token, reference.url || '')
  if (reference.url) session.knownDocs.set(reference.url, reference.url)
  while (session.knownDocs.size > 400) session.knownDocs.delete(session.knownDocs.keys().next().value)
}

export function rememberSearchDocuments(session, data) {
  // Only Search v2's top-level result metadata is a target capability. Never
  // recurse into titles, highlighted summaries, document bodies or comments.
  for (const record of Array.isArray(data?.results) ? data.results.slice(0, 20) : []) {
    rememberDocument(session, documentReference(record?.url))
    if (['docx', 'wiki'].includes(String(record?.doc_type || '').toLowerCase())) {
      rememberDocument(session, documentReference(record?.token || record?.document_id))
    }
  }
}

export function verifiedDocumentWrite(step, data, knownDocs) {
  if (!['docs.create', 'docs.append'].includes(step.tool)) return data
  const create = step.tool === 'docs.create'
  const target = !create ? documentReference(step.args.doc) : null
  const reference = documentReference(create ? data?.document?.url : (data?.document?.url || target?.url || knownDocs?.get(target?.token) || step.args.doc))
  const url = reference?.url || ''
  const hint = url ? ` 飞书返回的文档链接：${url}。` : ''
  if (data?.result !== undefined && data.result !== 'success') {
    throw new CliError(`飞书文档写入返回 ${String(data.result).slice(0, 50)}，未确认完整成功。${hint}`)
  }
  if (data?.warnings !== undefined && (!Array.isArray(data.warnings) || data.warnings.length)) {
    throw new CliError(`飞书文档写入存在警告，未确认完整成功：${JSON.stringify(data.warnings).slice(0, 1000)}。${hint}`)
  }
  if (create && (!url || reference.type !== 'docx' || data?.document?.document_id !== reference.token)) {
    throw new CliError('飞书没有返回相互匹配的新文档 ID 和真实文档 URL，不能确认创建成功。')
  }
  if (!create && (data?.result !== 'success' || !Number.isInteger(data?.document?.revision_id)
    || data.document.revision_id < 1 || !Number.isInteger(data.updated_blocks_count) || data.updated_blocks_count < 1)) {
    throw new CliError(`飞书没有返回可验证的追加成功结果、版本和更新块数。${hint}`)
  }
  if (!create && data?.document?.url) {
    if (!reference || reference.type !== 'docx' || (target.type !== 'wiki' && reference.token !== target.token)) {
      throw new CliError('飞书追加返回的文档链接与已确认目标不匹配，请在飞书核对状态。')
    }
  }
  return { ...data, ...(url ? { documentUrl: url, document: { ...data.document,
    ...(data.document.url ? { url } : {}),
  } } : {}) }
}

export function documentCompletion(step, data) {
  if (step.tool === 'docs.create') return `已创建文档《${step.args.title}》并写入已确认的完整内容。\n文档：${data.documentUrl}`
  if (step.tool === 'docs.append') return `已在文档末尾追加已确认的完整内容。\n文档：${data.documentUrl || step.args.doc}`
  return ''
}
