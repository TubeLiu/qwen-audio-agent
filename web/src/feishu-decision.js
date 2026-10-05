export function feishuDecisionResult(result, action) {
  if (result?.status === 'error') {
    return {
      status: 'error',
      text: result.text || result.error || '飞书操作执行失败，请查看任务结果。',
    }
  }
  if (result?.status !== 'done') {
    return {
      status: 'error',
      text: '飞书操作未返回明确结果，请查看任务状态，勿重复提交。',
    }
  }
  return {
    status: 'done',
    text: result.text || (action === 'cancel' ? '已取消本次操作。' : '本次飞书操作已执行。'),
  }
}
