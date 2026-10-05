import { randomUUID } from 'node:crypto';

export class PlanError extends Error { constructor(message) { super(message); this.name = 'PlanError'; } }

// A consumed plan keeps its final response so retries never repeat external writes.
export class PlanStore {
  constructor({ ttlMs = 300000, now = Date.now } = {}) { this.ttlMs = ttlMs; this.now = now; this.plans = new Map(); }
  create(sessionId, steps, { demo = false } = {}) {
    this.prune();
    if (this.plans.size >= 1000) throw new PlanError('待确认计划过多，请稍后重试。');
    const plan = { id: randomUUID(), sessionId, steps: structuredClone(steps), demo, state: 'pending', expires: this.now() + this.ttlMs };
    this.plans.set(plan.id, plan);
    return plan;
  }
  get(id, sessionId) {
    const plan = this.plans.get(id);
    if (!plan || plan.sessionId !== sessionId) throw new PlanError('确认计划不存在或不属于当前会话。');
    if (plan.state === 'pending' && plan.expires <= this.now()) { plan.state = 'expired'; throw new PlanError('确认计划已过期，请重新下达指令。'); }
    return plan;
  }
  async consume(id, sessionId, execute) {
    const plan = this.get(id, sessionId);
    if (plan.state === 'running' || plan.state === 'consumed') return plan.promise;
    if (plan.state !== 'pending') throw new PlanError('计划已取消或过期，请重新下达指令。');
    plan.state = 'running';
    plan.promise = Promise.resolve().then(() => execute(plan)).then(result => { plan.state = 'consumed'; plan.result = result; return result; }, error => { plan.state = 'consumed'; plan.result = { status: 'error', text: error.message }; return plan.result; });
    return plan.promise;
  }
  cancel(id, sessionId) {
    const plan = this.get(id, sessionId);
    if (plan.state !== 'pending' && plan.state !== 'cancelled') throw new PlanError('计划已执行或过期，不能取消。');
    plan.state = 'cancelled';
    return { status: 'done', text: '已取消；未执行这项飞书操作。' };
  }
  prune() {
    for (const [id, plan] of this.plans) if (plan.state !== 'running' && plan.expires + 60 * 60 * 1000 < this.now()) this.plans.delete(id);
  }
}
