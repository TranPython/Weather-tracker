// Code node "Analyze Infection" – đọc Excel 愛知県感染症情報 (2 tuần), tính số ca/定点 cho 衣浦東部 (保健所 của Kariya).
// Lưu kết quả vào staticData.infection (brief sáng dùng) và chỉ nhắn Telegram khi mức dịch thay đổi.
const AREA = '衣浦東部';
const state = $getWorkflowStaticData('global');
const manual = $execution.mode !== 'production';

// Ngưỡng theo số ca / 1 定点 / tuần. Cúm dùng chuẩn quốc gia (流行入り 1, 注意報 10, 警報 30).
const DEF = [
  { k: 'flu', re: /^インフルエンザ\(/, base: 'ARI', scope: 'area', name: 'Cúm (インフル)', lv: [1, 10, 30], lvName: ['流行入り', '注意報レベル', '警報レベル'] },
  { k: 'covid', re: /^COVID/, base: 'ARI', scope: 'area', name: 'COVID-19', lv: [5, 10, 20], lvName: ['tăng', 'cao', 'rất cao'] },
  { k: 'myco', re: /^マイコプラズマ肺炎$/, base: '基幹', scope: 'pref', name: 'マイコプラズマ肺炎 (toàn tỉnh)', lv: [1, 2, 4], lvName: ['tăng', 'cao', 'rất cao'] },
  { k: 'gastro', re: /^感染性胃腸炎$/, base: '小児科', scope: 'area', name: 'Viêm dạ dày ruột (ノロ等)', lv: [8, 12, 20], lvName: ['tăng', 'cao', '警報レベル'] },
];

const norm = (v) => (typeof v === 'string' ? v.replace(/[\s　]/g, '') : v);
const pad = (n) => String(n).padStart(2, '0');
const rows = $input.all().map((i) => (i.json.row || []).map(norm));

// Tách theo tuần (mỗi file bắt đầu bằng dòng tiêu đề "2026年37週（2026年9月7日～2026年9月13日）")
const weeks = [];
let cur = null;
for (const r of rows) {
  const title = r.find((v) => typeof v === 'string' && /\d{4}年\d+週（\d{4}年/.test(v));
  if (title) {
    const m = title.match(/(\d{4})年(\d+)週（(\d{4})年(\d+)月(\d+)日～(\d{4})年(\d+)月(\d+)日）/);
    if (!m) throw new Error(`Aichi Excel: không đọc được tiêu đề tuần "${title}"`);
    cur = { week: `${m[1]}${pad(m[2])}`, wk: +m[2], label: `W${+m[2]} (${+m[5]}/${+m[4]}–${+m[8]}/${+m[7]})`,
      end: `${m[6]}-${pad(m[7])}-${pad(m[8])}`, rows: [] };
    weeks.push(cur);
  } else if (cur) cur.rows.push(r);
}
if (!weeks.length) throw new Error('Aichi Excel: không thấy dòng tiêu đề tuần (file đổi cấu trúc?)');

function parseWeek(w) {
  const hdr = w.rows.find((r) => r.includes('愛知県(保健所別)'));
  if (!hdr) throw new Error(`Aichi Excel ${w.week}: không thấy header "愛知県(保健所別)"`);
  const base = { ARI: hdr.indexOf('ARI'), '小児科': hdr.indexOf('小児科'), '基幹': hdr.indexOf('基幹') };
  const ariCol = hdr.findIndex((v) => typeof v === 'string' && /^急性呼吸器感染症/.test(v));
  const rowOf = (name) => w.rows.find((r) => r[1] === name);
  const area = rowOf(AREA);
  const pref = rowOf('愛知県全体');
  if (!area || !pref || ariCol < 0 || Object.values(base).some((i) => i < 0)) throw new Error(`Aichi Excel ${w.week}: thiếu cột/dòng (${AREA}, 愛知県全体, ARI…)`);
  const per = (row, col, b) => { const n = +row[col]; const d = +row[base[b]]; return d > 0 && !isNaN(n) ? n / d : null; };
  const out = { ari: per(area, ariCol, 'ARI') };
  for (const d of DEF) {
    const col = hdr.findIndex((v, i) => i > ariCol - 1 && typeof v === 'string' && d.re.test(v));
    if (col < 0) throw new Error(`Aichi Excel ${w.week}: không thấy cột ${d.k}`);
    out[d.k] = per(d.scope === 'pref' ? pref : area, col, d.base);
  }
  return out;
}

weeks.sort((a, b) => a.week.localeCompare(b.week));
const now = weeks[weeks.length - 1];
const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
const V = parseWeek(now);
const P = prev ? parseWeek(prev) : {};

const r1 = (x) => (x == null ? '?' : Math.round(x * 10) / 10);
const level = (d, v) => (v == null ? 0 : d.lv.filter((t) => v >= t).length);
const arrow = (v, p) => (p == null || v == null ? '' : v > p * 1.15 ? ` ↑ từ ${r1(p)}` : v < p * 0.85 ? ` ↓ từ ${r1(p)}` : ' →');
const DOT = ['⚪', '🟡', '🟠', '🔴'];

const items = DEF.map((d) => ({ k: d.k, name: d.name, v: V[d.k], p: P[d.k], lv: level(d, V[d.k]), plv: level(d, P[d.k]), lvName: d.lvName }));
const maxLv = Math.max(...items.map((x) => x.lv));
const changed = items.filter((x) => x.lv !== x.plv);
const ariJump = V.ari != null && P.ari != null && P.ari >= 20 && V.ari >= P.ari * 1.3;

// Dòng ngắn cho brief sáng
const active = items.filter((x) => x.lv >= 1);
const briefLine = active.length
  ? `${AREA} ${now.label}: ${active.map((x) => `${x.name.split(' (')[0]} ${r1(x.v)}/定点 (${x.lvName[x.lv - 1]}${arrow(x.v, x.p)})`).join(', ')}`
  : '';
const advice = [];
if (items.find((x) => x.k === 'flu').lv >= 1 || items.find((x) => x.k === 'covid').lv >= 1 || ariJump) advice.push('khẩu trang trên tàu/xe buýt & chỗ đông, rửa tay, súc miệng');
const month = +now.end.slice(5, 7);
if (items.find((x) => x.k === 'flu').lv >= 1 && month >= 9 && month <= 12) advice.push('cân nhắc tiêm phòng cúm (10–11月)');
if (items.find((x) => x.k === 'gastro').lv >= 1) advice.push('rửa tay bằng xà phòng (cồn ít tác dụng với norovirus), cẩn thận hàu/đồ sống');

state.infection = { week: now.week, label: now.label, end: now.end, area: AREA, maxLv, ariJump, briefLine,
  advice: advice.join('; '), fluLv: items.find((x) => x.k === 'flu').lv, updatedAt: new Date().toISOString() };

if (!manual && !changed.length && !ariJump && maxLv < 2) return [];

const lines = items.map((x) => `${DOT[x.lv]} ${x.name}: ${r1(x.v)}/定点${arrow(x.v, x.p)}${x.lv ? ` — ${x.lvName[x.lv - 1]}` : ''}`);
lines.push(`${ariJump ? '⚠️' : '•'} Hô hấp cấp chung (ARI): ${r1(V.ari)}/定点${arrow(V.ari, P.ari)}`);
const text = [
  `${manual ? '🧪 TEST\n' : ''}🦠 <b>Dịch bệnh · ${AREA} (Kariya) · ${now.label}</b>`,
  ...lines,
  advice.length ? `👉 ${advice.join('; ')}` : '✅ Chưa cần khẩu trang vì dịch.',
  '<i>Nguồn: 愛知県衛生研究所, số liệu tuần (trễ ~1 tuần)</i>',
].join('\n');
return [{ json: { text } }];
