// This is an admission fallback, not an operation planner or permission grant.
// Ambiguous/informational turns retain the model's normal tool routing.
export function explicitFeishuObjective(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 4000) return null;
  if (/<(?:restored_context|backend_input_request|permission_request|input_parts|user_memory|runtime_context|task_result)\b|```/iu.test(text)) return null;
  // Quoted titles/content are data, not evidence of an action. Inspect the
  // leading intent only; ordinary words in the requested document must survive.
  const intent = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|《[^》]*》|"[^"]*"|'[^']*'/gu, ' ')
    .split(/(?:正文|内容|备注|标题|名称|名字)(?:是|为|叫|[:：])|叫做/u, 1)[0].trim();
  if (!/(?:飞书|云文档|多维表格)/u.test(intent)) return null;
  const action = /(?:查询|查一下|查一查|查看|读取|读一下|搜索|查找|新建|创建|建立|发送|发消息|添加|追加|更新|修改|删除|安排)/u.exec(intent);
  if (!action) return null;
  const prefix = intent.slice(0, action.index);
  const asksForHelp = /(?:帮我|替我|给我|为我)/u.test(prefix);
  if (/(?:介绍|解释|教程|示例|举例|假设|假如|引用|转述|复述|总结|摘要|分析|比较|区别|什么|如何|怎么|怎样|为什么|为何|配置|设置|安装|授权|登录|密钥|API\s*Key|能力|功能|资料|写着|提到|文档[里中].{0,12}(?:写着|说|提到|要求)|取消|停止|撤销|不要|别|无需|不用|不必|不想|禁止|勿)/iu.test(prefix)) return null;
  if (!asksForHelp && /(?:支持|能不能|可不可以|能否|是否|你(?:能|会|可以))/u.test(prefix)) return null;
  if (/^(?:查询|查|查看)/u.test(action[0]) && /(?:任务|工作).{0,12}(?:状态|进度)/u.test(intent)) return null;
  if (/(?:如何|怎么|怎样|为什么|为何).{0,35}(?:吗|么|[?？])$|(?:是什么|什么意思|怎么样|好用吗|有哪些|有啥)[?？]?$/u.test(intent)) return null;
  if (!asksForHelp && /(?:能|可以|会|支持).{0,35}(?:吗|么|[?？])$/u.test(intent)) return null;
  return text;
}
