import assert from 'node:assert/strict'
import test from 'node:test'
import { feishuDecisionResult } from '../src/feishu-decision.js'

test('an HTTP-success execution failure retains its error status and exact partial-failure message', () => {
  const result = feishuDecisionResult({
    status: 'error', text: '第 1 项已完成，第 2 项授权失效；请勿重复执行第 1 项。',
  }, 'confirm')
  assert.deepEqual(result, {
    status: 'error', text: '第 1 项已完成，第 2 项授权失效；请勿重复执行第 1 项。',
  })
  assert.notEqual(result.status, 'confirmation')
})

test('successful confirm and cancel have separate fallbacks and preserve a server result', () => {
  assert.deepEqual(feishuDecisionResult({ status: 'done' }, 'confirm'), {
    status: 'done', text: '本次飞书操作已执行。',
  })
  assert.deepEqual(feishuDecisionResult({ status: 'done' }, 'cancel'), {
    status: 'done', text: '已取消本次操作。',
  })
  assert.deepEqual(feishuDecisionResult({ status: 'done', text: '已完成 2 项飞书操作。' }, 'confirm'), {
    status: 'done', text: '已完成 2 项飞书操作。',
  })
})

test('an absent or unexpected execution status never becomes success or a reusable confirmation', () => {
  for (const value of [null, {}, { status: 'confirmation' }, { status: 'clarification' }]) {
    const result = feishuDecisionResult(value, 'confirm')
    assert.equal(result.status, 'error')
    assert.match(result.text, /勿重复提交/u)
  }
})
