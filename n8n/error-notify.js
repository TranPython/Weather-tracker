// Code node "Format Error" trong workflow "Error notifier".
// Nhận output của Error Trigger, chống spam: cùng workflow + node + lỗi chỉ báo 1 lần / 3 giờ.
const THROTTLE_H = 3;
const e = $input.first().json;
const state = $getWorkflowStaticData('global');
state.seen = state.seen || {};

const wf = (e.workflow && e.workflow.name) || '?';
const ex = e.execution || {};
const err = ex.error || (e.trigger && e.trigger.error) || {};
const node = ex.lastNodeExecuted || (err.node && err.node.name) || (e.trigger ? 'trigger' : '?');
const msg = String(err.message || err.description || 'Unknown error');
const key = `${e.workflow && e.workflow.id}|${node}|${msg.slice(0, 120)}`;

const now = Date.now();
for (const k of Object.keys(state.seen)) if (now - state.seen[k].last > 24 * 3600e3) delete state.seen[k];
const s = state.seen[key];
if (s && now - s.last < THROTTLE_H * 3600e3) { s.count += 1; return []; }
const repeats = s ? s.count : 0;
state.seen[key] = { last: now, count: 0 };

const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const when = DateTime.now().setZone('Asia/Tokyo').toFormat('d/M HH:mm');
const text = [
  `🔥 <b>n8n lỗi: ${esc(wf)}</b>`,
  `Node: <code>${esc(node)}</code> · ${when}`,
  `<code>${esc(msg.slice(0, 500))}</code>`,
  repeats ? `(+${repeats} lần lặp trong ${THROTTLE_H}h qua đã bị ẩn)` : '',
  ex.url ? `<a href="${esc(ex.url)}">Mở execution</a>` : '',
].filter(Boolean).join('\n');
return [{ json: { text } }];
