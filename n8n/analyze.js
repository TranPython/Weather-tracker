// Weather tracker – Kariya (448-0003). Code node "Analyze & Decide" (Run once for all items).
// Chạy mỗi 15 phút; tự quyết định có nhắn Telegram hay không. Trả về [] = im lặng.

// ===================== CONFIG =====================
const CFG = {
  place: 'Kariya',
  lat: 35.000, lon: 137.020,          // 刈谷市一ツ木町 (448-0003)
  jmaCity: '2321000',                 // 刈谷市 (class20)
  jmaArea: '230010',                  // 愛知県西部 (class10, dùng cho 降水確率)
  morningWeekday: '06:45',            // brief sáng ngày làm việc (dậy 6:30, đi 7:30)
  morningWeekend: '08:00',
  afternoon: '16:00',                 // check trước giờ về (ngày làm việc)
  evening: '21:00',                   // preview ngày mai
  awake: [6 * 60 + 30, 23 * 60],      // giờ thức (phút trong ngày)
  commuteOut: [7, 9],                 // giờ ra ngoài buổi sáng [from, to)
  commuteHome: [17, 20],              // giờ về
  atWork: [7 * 60 + 30, 17 * 60],     // đang ở công ty → không nhắc "sắp mưa"
  sendMinSev: 2,                      // gửi brief nếu có mục >= mức này
  sendIfSev1Count: 2,                 // ...hoặc có >= N mục mức 1
  rainSoonCooldownH: 6,
  ignoreWarnings: ['07', '16', '37'], // 波浪 – không liên quan sinh hoạt
};

// ===================== HELPERS =====================
const tz = 'Asia/Tokyo';
const now = DateTime.now().setZone(tz);
const today = now.toISODate();
const tomorrow = now.plus({ days: 1 }).toISODate();
const nowMin = now.hour * 60 + now.minute;
const slot = now.toFormat('HH:') + String(Math.floor(now.minute / 15) * 15).padStart(2, '0');
const awake = nowMin >= CFG.awake[0] && nowMin < CFG.awake[1];
const isWorkday = (iso) => DateTime.fromISO(iso, { zone: tz }).weekday <= 5;
const DOW = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const dayLabel = (iso) => { const d = DateTime.fromISO(iso, { zone: tz }); return `${DOW[d.weekday]} ${d.day}/${d.month}`; };

let isManual = false;
try { isManual = $('Test now').isExecuted; } catch (e) {}
const state = $getWorkflowStaticData('global');
state.sent = state.sent || {};
state.cooldown = state.cooldown || {};
state.tc = state.tc || {};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (x) => Math.round(x * 10) / 10;
const safe = (name) => {
  try { return $(name).all().map((i) => i.json).filter((j) => j && !j.error && Object.keys(j).length); }
  catch (e) { return []; }
};
const toRows = (src) => {
  const rows = [];
  if (!src || !src.hourly || !src.hourly.time) return rows;
  const keys = Object.keys(src.hourly).filter((k) => k !== 'time');
  src.hourly.time.forEach((t, i) => {
    const o = { t, date: t.slice(0, 10), h: +t.slice(11, 13) };
    keys.forEach((k) => { o[k] = src.hourly[k][i]; });
    rows.push(o);
  });
  return rows;
};
const H = toRows(safe('Open-Meteo Forecast')[0]);
const AQ = toRows(safe('Open-Meteo Air Quality')[0]);
const hrs = (rows, date, from, to) => rows.filter((x) => x.date === date && x.h >= from && x.h < to);
const mx = (a, k) => (a.length ? Math.max(...a.map((x) => x[k] ?? -999)) : null);
const mn = (a, k) => (a.length ? Math.min(...a.map((x) => x[k] ?? 999)) : null);
const avg = (a, k) => (a.length ? a.reduce((s, x) => s + (x[k] ?? 0), 0) / a.length : null);

// Độ ẩm tuyệt đối (g/m³) – < 7 là vùng virus cúm dễ sống/lây
const absHum = (T, RH) => (6.112 * Math.exp((17.67 * T) / (T + 243.5)) * RH * 2.1674) / (273.15 + T);
// WBGT ước tính (công thức 小野 – 環境省 dùng cho dự báo), SR: kW/m², WS: m/s
const wbgt = (T, RH, SR, WS) => 0.735 * T + 0.0374 * RH + 0.00292 * T * RH + 7.619 * SR - 4.557 * SR * SR - 0.0572 * WS - 4.064;

const WX = (c) => {
  if (c >= 95) return ['⛈', 'giông sét'];
  if (c >= 85 || (c >= 71 && c <= 77)) return ['❄️', 'tuyết'];
  if (c >= 80) return ['🌦', 'mưa rào'];
  if (c >= 65) return ['🌧', 'mưa to'];
  if (c >= 61) return ['🌧', 'mưa'];
  if (c >= 51) return ['🌦', 'mưa phùn'];
  if (c >= 45) return ['🌫', 'sương mù'];
  if (c === 3) return ['☁️', 'nhiều mây'];
  if (c === 2) return ['⛅', 'mây rải rác'];
  return ['☀️', 'nắng'];
};

// ===================== JMA =====================
const jmaPops = (() => {
  const fc = safe('JMA Forecast')[0];
  const ts = fc && fc.timeSeries && fc.timeSeries[1];
  const area = ts && (ts.areas || []).find((a) => a.area && a.area.code === CFG.jmaArea);
  if (!area) return [];
  return ts.timeDefines
    .map((t, i) => ({ date: t.slice(0, 10), h: +t.slice(11, 13), pop: area.pops[i] }))
    .filter((p) => p.pop !== '' && p.pop != null)
    .map((p) => ({ ...p, pop: +p.pop }));
})();

// Bảng mã 防災気象情報 mới (từ 29/5/2026)
const W = {
  '33': ['大雨特別警報', 50], '43': ['大雨危険警報', 40], '03': ['大雨警報', 30], '10': ['大雨注意報', 20],
  '39': ['土砂災害特別警報', 50], '49': ['土砂災害危険警報', 40], '09': ['土砂災害警報', 30], '29': ['土砂災害注意報', 20],
  '38': ['高潮特別警報', 50], '48': ['高潮危険警報', 40], '08': ['高潮警報', 30], '19': ['高潮注意報', 20],
  '35': ['暴風特別警報', 50], '05': ['暴風警報', 30], '15': ['強風注意報', 20],
  '32': ['暴風雪特別警報', 50], '02': ['暴風雪警報', 30], '13': ['風雪注意報', 20],
  '36': ['大雪特別警報', 50], '06': ['大雪警報', 30], '12': ['大雪注意報', 20],
  '37': ['波浪特別警報', 50], '07': ['波浪警報', 30], '16': ['波浪注意報', 20],
  '14': ['雷注意報', 20], '17': ['融雪注意報', 20], '20': ['濃霧注意報', 20], '21': ['乾燥注意報', 20],
  '22': ['なだれ注意報', 20], '23': ['低温注意報', 20], '24': ['霜注意報', 20], '25': ['着氷注意報', 20], '26': ['着雪注意報', 20],
};
const IMMEDIATE_ADVISORY = ['10', '29', '14', '15']; // 注意報 đáng báo ngay khi đang thức

const warnings = (() => {
  const act = {};
  let headline = '';
  for (const r of safe('JMA Warnings')) {
    for (const a of (r.warning && r.warning.class20Items) || []) {
      if (a.areaCode !== CFG.jmaCity) continue;
      for (const k of a.kinds || []) {
        if (!k.code || /解除|なし/.test(k.status || '') || CFG.ignoreWarnings.includes(k.code)) continue;
        const [name, level] = W[k.code] || [`code ${k.code}`, 20];
        act[k.code] = { code: k.code, name, level, status: k.status };
        headline = r.headlineText || headline;
      }
    }
  }
  return { list: Object.values(act).sort((a, b) => b.level - a.level), headline };
})();
const wIcon = (lv) => (lv >= 50 ? '🟪' : lv >= 40 ? '🟥' : lv >= 30 ? '🟧' : '🟨');
const warnLine = (list) => list.map((w) => `${wIcon(w.level)} ${w.name}${w.level >= 30 ? ` (L${w.level / 10})` : ''}`).join(', ');

// ===================== BÃO =====================
const typhoons = (() => {
  const out = [];
  let cur = null;
  for (const it of safe('JMA Typhoon Details')) {
    if (it.part === 'title') {
      cur = { num: it.typhoonNumber || '', name: (it.name && (it.name.jp || it.name.en)) || '', cat: it.category && it.category.jp, pts: [] };
      out.push(cur);
    } else if (cur && it.position && it.position.deg) {
      const [la, lo] = it.position.deg;
      const toR = Math.PI / 180;
      const d = 6371 * 2 * Math.asin(Math.sqrt(Math.sin(((la - CFG.lat) * toR) / 2) ** 2 +
        Math.cos(CFG.lat * toR) * Math.cos(la * toR) * Math.sin(((lo - CFG.lon) * toR) / 2) ** 2));
      const storm = Math.max(0, ...((it.stormWarning || []).map((s) => (s.range && s.range.km) || 0)));
      cur.pts.push({ d, circle: (it.probabilityCircleRadius && it.probabilityCircleRadius.km) || 0, storm,
        t: it.validtime && it.validtime.JST, wind: it.maximumWind && it.maximumWind.sustained && it.maximumWind.sustained['m/s'],
        p: it.pressure, intensity: it.intensity });
    }
  }
  return out.map((tc) => {
    if (!tc.pts.length) return null;
    const c = tc.pts.reduce((a, b) => (b.d < a.d ? b : a));
    const inStormArea = c.d <= c.circle + c.storm; // Kariya nằm trong 暴風警戒域 dự báo
    const risk = inStormArea || c.d <= 300 ? 'high' : c.d <= 1000 || c.d <= c.circle + c.storm + 300 ? 'watch' : 'far';
    const hoursAhead = c.t ? DateTime.fromISO(c.t).diff(now, 'hours').hours : 999;
    const no = tc.num ? `Bão số ${+tc.num.slice(2)}` : 'Áp thấp';
    const when = c.t ? DateTime.fromISO(c.t, { zone: tz }).toFormat('d/M HH') + 'h' : '';
    const text = `${no} (${esc(tc.name)}): gần Kariya nhất ~${Math.round(c.d)} km lúc ${when}` +
      `${c.circle ? ` (vòng xác suất ${c.circle} km)` : ''}, gió ${c.wind || '?'} m/s, ${c.p} hPa`;
    return { key: tc.num || tc.name, risk, soon: hoursAhead <= 72,
      text: text + (risk === 'high' ? ' — <b>Kariya nằm trong 暴風警戒域 dự báo</b>' : ' — theo dõi') };
  }).filter((x) => x && x.risk !== 'far');
})();

// ===================== PHÂN TÍCH NGÀY =====================
const wet = (x) => (x.precipitation ?? 0) >= 0.3 || (x.precipitation_probability ?? 0) >= 50;
function rainSpans(rows) {
  const out = [];
  let cur = null;
  for (const x of rows) {
    if (wet(x)) {
      if (!cur) { cur = { from: x.h, to: x.h + 1, mm: 0, pop: 0 }; out.push(cur); }
      cur.to = x.h + 1; cur.mm = Math.max(cur.mm, x.precipitation || 0); cur.pop = Math.max(cur.pop, x.precipitation_probability || 0);
    } else cur = null;
  }
  return out;
}

function laundry(date, workday) {
  const until = workday ? CFG.commuteHome[1] - 1 : 17;
  const win = hrs(H, date, 8, until);
  if (win.length < 5) return null;
  const aq = hrs(AQ, date, 8, until);
  const rainAt = win.find((x) => (x.precipitation || 0) >= 0.2 || (x.precipitation_probability || 0) >= 40);
  const rh = avg(hrs(H, date, 9, 16), 'relative_humidity_2m');
  const sr = avg(hrs(H, date, 9, 15), 'shortwave_radiation');
  const wind = avg(hrs(H, date, 9, 16), 'wind_speed_10m');
  const gust = mx(win, 'wind_gusts_10m');
  const dirty = (mx(aq, 'pm2_5') ?? 0) >= 35 || (mx(aq, 'dust') ?? 0) >= 50;
  let lv; let text;
  if (rainAt) { lv = 0; text = `Phơi trong nhà (部屋干し) — có thể mưa từ ~${rainAt.h}h`; }
  else if (dirty) { lv = 0; text = 'Phơi trong nhà — nhiều bụi/PM2.5/黄砂'; }
  else if (rh >= 80 || (sr < 150 && wind < 2)) { lv = 1; text = `Phơi ngoài được nhưng khô chậm (ẩm ~${Math.round(rh)}%)`; }
  else if (rh <= 65 && (sr >= 300 || wind >= 3)) { lv = 3; text = 'Rất hợp giặt & phơi ngoài'; }
  else { lv = 2; text = 'Phơi ngoài OK'; }
  if (lv >= 2 && gust >= 10) text += `, gió giật ${Math.round(gust)} m/s → kẹp chặt`;
  if (lv >= 1) {
    const late = hrs(H, date, until, 23).find(wet);
    if (late) text += ` · nhớ cất đồ trước ~${late.h}h`;
  }
  return { lv, text };
}

function analyzeDay(date, workday) {
  const all = hrs(H, date, 0, 24);
  if (all.length < 20) return null;
  const f = [];
  const add = (sev, icon, text) => f.push({ sev, icon, text });
  const day = hrs(H, date, 6, 21);
  const win = workday ? [CFG.commuteOut, CFG.commuteHome] : [[8, 21]];
  const inWin = (h) => win.some(([a, b]) => h >= a && h < b);
  const tmax = mx(all, 'temperature_2m');
  const tmin = mn(all, 'temperature_2m');

  // Mưa / ô
  const spans = rainSpans(hrs(H, date, 6, 23));
  const jp = jmaPops.filter((p) => p.date === date && p.h >= 6);
  const jmaMax = Math.max(0, ...jp.map((p) => p.pop));
  const hitWin = spans.some((s) => win.some(([a, b]) => s.from < b && s.to > a));
  const popWin = Math.max(0, ...day.filter((x) => inWin(x.h)).map((x) => x.precipitation_probability || 0));
  const maxMm = Math.max(0, ...spans.map((s) => s.mm));
  const jTxt = jp.length ? ` · JMA ${jp.map((p) => `${p.h}-${p.h + 6}h ${p.pop}%`).join(', ')}` : '';
  const sTxt = spans.map((s) => `${s.from}–${s.to}h (${s.pop}%, ${r1(s.mm)}mm/h)`).join('; ');
  if (maxMm >= 20) add(3, '🌊', `Mưa rất to (${r1(maxMm)}mm/h) — đề phòng ngập đường/hầm chui`);
  else if (maxMm >= 10) add(3, '🌧', `Mưa to (${r1(maxMm)}mm/h) — giày chống nước, đi sớm hơn`);
  if (hitWin || jmaMax >= 50) add(2, '☂️', `<b>Mang ô</b>: ${sTxt || 'khả năng mưa cao'}${jTxt}`);
  else if (spans.length) add(1, '🌂', `Mưa ${sTxt} (lúc bạn ở trong nhà/công ty) — ô gấp phòng hờ${jTxt}`);
  else if (popWin >= 30 || jmaMax >= 30) add(1, '🌂', `Có thể mưa (${Math.max(popWin, jmaMax)}%) — bỏ ô gấp vào túi${jTxt}`);

  // Giông, tuyết, sương mù
  const th = day.find((x) => (x.weather_code || 0) >= 95);
  if (th) add(2, '⛈', `Có thể giông sét ~${th.h}h — tránh chỗ trống, rút phích thiết bị nhạy cảm`);
  const sn = day.find((x) => [71, 73, 75, 77, 85, 86].includes(x.weather_code));
  if (sn) add(2, '❄️', `Có thể có tuyết ~${sn.h}h — đường trơn, đi sớm`);
  const fog = hrs(H, date, 5, 9).find((x) => x.weather_code === 45 || x.weather_code === 48);
  if (fog) add(1, '🌫', 'Sương mù buổi sáng — tầm nhìn kém nếu lái xe');

  // Gió
  const gust = mx(day.filter((x) => inWin(x.h) || !workday), 'wind_gusts_10m') ?? 0;
  if (gust >= 20) add(3, '💨', `Gió giật rất mạnh ${Math.round(gust)} m/s — không dùng ô được, cẩn thận vật bay, cất đồ ban công`);
  else if (gust >= 15) add(2, '💨', `Gió giật mạnh ${Math.round(gust)} m/s — ô dễ lật, cân nhắc áo mưa`);
  else if (gust >= 12) add(1, '🍃', `Gió khá mạnh (giật ${Math.round(gust)} m/s)`);

  // Nóng
  const wb = Math.max(...hrs(H, date, 9, 18).map((x) => wbgt(x.temperature_2m, x.relative_humidity_2m, (x.shortwave_radiation || 0) / 1000, x.wind_speed_10m || 0)));
  if (tmax >= 35 || wb >= 31) add(3, '🥵', `Nắng nóng nguy hiểm: max ${r1(tmax)}°C, WBGT ~${Math.round(wb)} (危険) — uống nước + muối, hạn chế ra ngoài, bật điều hòa`);
  else if (wb >= 28) add(2, '🥵', `Nóng: max ${r1(tmax)}°C, WBGT ~${Math.round(wb)} (厳重警戒) — mang nước, 冷感タオル`);
  else if (wb >= 25 && tmax >= 28) add(1, '☀️', `Khá nóng: max ${r1(tmax)}°C (WBGT ~${Math.round(wb)} 警戒)`);

  // Lạnh & biến động nhiệt
  if (tmin <= 0) add(2, '🥶', `Min ${r1(tmin)}°C — có thể đóng băng: kính xe/đường trơn, mặc ấm`);
  else if (tmin <= 5) add(1, '🧣', `Sáng lạnh ${r1(tmin)}°C — áo ấm, khăn`);
  const prev = DateTime.fromISO(date, { zone: tz }).minus({ days: 1 }).toISODate();
  const pmax = mx(hrs(H, prev, 0, 24), 'temperature_2m');
  if (pmax != null && pmax > -900) {
    const dT = tmax - pmax;
    if (Math.abs(dT) >= 5) add(2, dT < 0 ? '📉' : '📈', `Nhiệt độ max ${dT < 0 ? 'giảm' : 'tăng'} ${r1(Math.abs(dT))}°C so với hôm trước (${r1(pmax)} → ${r1(tmax)}°C) — chỉnh quần áo`);
  }
  if (workday) {
    const eve = hrs(H, date, CFG.commuteHome[0], CFG.commuteHome[1]);
    const eveMin = mn(eve, 'temperature_2m');
    if (eveMin != null && tmax - eveMin >= 8 && eveMin < 18) add(1, '🧥', `Chiều tối hạ còn ~${r1(eveMin)}°C — mang áo khoác mỏng`);
  }

  // UV
  const uv = mx(hrs(H, date, 9, 16), 'uv_index') ?? 0;
  if (uv >= 11) add(2, '🧴', `UV cực mạnh (${r1(uv)}) — kem chống nắng, mũ, kính`);
  else if (uv >= (workday ? 8 : 6)) add(1, '🧴', `UV mạnh (${r1(uv)}) — kem chống nắng nếu ra ngoài buổi trưa`);

  // Độ ẩm / hô hấp
  const rhMin = mn(day, 'relative_humidity_2m');
  const ah = avg(all.map((x) => ({ v: absHum(x.temperature_2m, x.relative_humidity_2m) })), 'v');
  const rhDay = avg(hrs(H, date, 9, 18), 'relative_humidity_2m');
  if (ah < 7) add(ah < 5 ? 2 : 1, '😷', `Độ ẩm tuyệt đối thấp (${r1(ah)} g/m³) — virus cúm/cảm dễ lây: khẩu trang chỗ đông, máy tạo ẩm 50–60%`);
  if (rhMin <= 30) add(1, '💧', `Rất khô (RH min ${rhMin}%) — uống nước, dưỡng ẩm, cẩn thận tĩnh điện`);
  if (rhDay >= 80 && tmax >= 27) add(1, '💦', `Oi bức (ẩm ~${Math.round(rhDay)}%) — bật 除湿, chú ý nấm mốc/đồ ăn`);

  // Không khí
  const aq = hrs(AQ, date, 6, 22);
  const pm = mx(aq, 'pm2_5') ?? 0;
  const dust = mx(aq, 'dust') ?? 0;
  if (pm >= 70) add(3, '😷', `PM2.5 rất cao (${Math.round(pm)} µg/m³, mức 注意喚起) — hạn chế ra ngoài, đóng cửa sổ, khẩu trang N95`);
  else if (pm >= 35) add(2, '😷', `PM2.5 cao (${Math.round(pm)} µg/m³) — đeo khẩu trang khi ra ngoài`);
  if (dust >= 50) add(2, '🟤', `黄砂/bụi (${Math.round(dust)} µg/m³) — khẩu trang, không phơi đồ ngoài, rửa xe sau`);

  // Phấn hoa (heuristic tháng 2–4: ấm, gió, khô → bay nhiều)
  const mon = DateTime.fromISO(date).month;
  if (mon >= 2 && mon <= 4 && tmax >= 13 && !spans.length && gust >= 8) add(1, '🤧', 'Ngày ấm, gió, khô mùa 花粉 — phấn hoa bay nhiều: khẩu trang, kính');

  const dom = day.reduce((m, x) => ((x.weather_code || 0) > m ? x.weather_code : m), 0);
  return { date, workday, flags: f.sort((a, b) => b.sev - a.sev), tmax, tmin, wx: WX(dom), laundry: laundry(date, workday) };
}

const worth = (a) => a && (a.flags.some((x) => x.sev >= CFG.sendMinSev) || a.flags.filter((x) => x.sev >= 1).length >= CFG.sendIfSev1Count);
const lines = (a, minSev = 1) => a.flags.filter((x) => x.sev >= minSev).map((x) => `${x.icon} ${x.text}`);

// ===================== QUYẾT ĐỊNH GỬI =====================
const parts = [];
let briefHasWarn = false;
const dataOk = H.length > 0;
const morningSlot = isWorkday(today) ? CFG.morningWeekday : CFG.morningWeekend;

// 1) Brief buổi sáng
if (isManual || (slot === morningSlot && state.sent.morning !== today)) {
  state.sent.morning = today;
  if (!dataOk) {
    parts.push('⚠️ Không lấy được dữ liệu Open-Meteo sáng nay — tự xem tenki.jp nhé.');
  } else {
    const a = analyzeDay(today, isWorkday(today));
    const L = a.laundry;
    const prevBad = [1, 2].every((n) => { const d = now.minus({ days: n }).toISODate(); const l = laundry(d, false); return l && l.lv <= 1; });
    const goodAfterBad = L && L.lv === 3 && prevBad;
    const hasWarn = warnings.list.length > 0;
    const tcHigh = typhoons.some((t) => t.risk === 'high' && t.soon);
    if (isManual || worth(a) || goodAfterBad || hasWarn || tcHigh) {
      const hdr = `${a.wx[0]} <b>Sáng ${dayLabel(today)} · ${CFG.place}</b>  ${r1(a.tmin)}–${r1(a.tmax)}°C, ${a.wx[1]}`;
      const body = [];
      if (hasWarn) { body.push(`🚨 JMA: ${warnLine(warnings.list)}`); briefHasWarn = true; }
      typhoons.forEach((t) => body.push(`🌀 ${t.text}`));
      body.push(...lines(a));
      if (!body.length) body.push('✅ Không có gì bất thường.');
      if (L) body.push(`🧺 ${L.text}${goodAfterBad ? ' (sau mấy ngày ẩm ướt — tranh thủ!)' : ''}`);
      parts.push([hdr, ...body].join('\n'));
      state.homeRainNotified = a.flags.some((x) => x.icon === '☂️') ? today : state.homeRainNotified;
    }
  }
}

// 2) Trước giờ về (ngày làm việc)
if (!isManual && dataOk && isWorkday(today) && slot === CFG.afternoon && state.sent.afternoon !== today) {
  state.sent.afternoon = today;
  const eve = hrs(H, today, CFG.commuteHome[0], CFG.commuteHome[1]);
  const rain = eve.filter(wet);
  const gust = mx(eve, 'wind_gusts_10m') ?? 0;
  const msg = [];
  if (rain.length && state.homeRainNotified !== today) {
    msg.push(`☂️ Giờ về có mưa: ${rain[0].h}–${rain[rain.length - 1].h + 1}h (tối đa ${Math.max(...rain.map((x) => x.precipitation_probability || 0))}%, ${r1(Math.max(...rain.map((x) => x.precipitation || 0)))}mm/h) — nhớ lấy ô.`);
  }
  if (gust >= 15) msg.push(`💨 Gió giật ${Math.round(gust)} m/s lúc về — cẩn thận.`);
  if (msg.length) parts.push(`🌆 <b>Trước giờ về</b>\n${msg.join('\n')}`);
}

// 3) Preview ngày mai (21:00)
if (isManual || (dataOk && slot === CFG.evening && state.sent.evening !== today)) {
  state.sent.evening = today;
  const b = analyzeDay(tomorrow, isWorkday(tomorrow));
  if (b) {
    const important = b.flags.filter((x) => x.sev >= 2);
    const tcHigh = typhoons.filter((t) => t.risk === 'high' && t.soon);
    const night = hrs(H, today, 21, 24).concat(hrs(H, tomorrow, 0, 6)).filter(wet);
    if (isManual || important.length || tcHigh.length || night.length) {
      const todo = [];
      if (b.flags.some((x) => x.icon === '☂️')) todo.push('để ô cạnh cửa');
      if (b.flags.some((x) => ['🌊', '🌧', '❄️'].includes(x.icon) || x.sev >= 3)) todo.push('đặt báo thức sớm hơn ~15 phút');
      if (b.flags.some((x) => ['🥶', '🧣', '📉'].includes(x.icon))) todo.push('chuẩn bị áo ấm');
      if (b.laundry && b.laundry.lv === 0) todo.push('đừng hẹn giờ giặt để phơi ngoài');
      if (b.laundry && b.laundry.lv === 3) todo.push('mai phơi đồ ngoài tốt — có thể hẹn giờ máy giặt');
      if (tcHigh.length) todo.push('bão: cất đồ ban công, sạc pin dự phòng, nước + đèn pin, xem lịch tàu sáng mai');
      const body = [];
      if (night.length) body.push(`🌙 Đêm nay có mưa từ ~${night[0].h}h — đóng cửa sổ, cất đồ ban công`);
      tcHigh.forEach((t) => body.push(`🌀 ${t.text}`));
      body.push(...lines(b, isManual ? 1 : 2));
      if (!body.length) body.push('✅ Không có gì bất thường.');
      if (todo.length) body.push(`📝 Tối nay: ${todo.join('; ')}`);
      parts.push([`${b.wx[0]} <b>Ngày mai ${dayLabel(tomorrow)}</b>  ${r1(b.tmin)}–${r1(b.tmax)}°C, ${b.wx[1]}`, ...body].join('\n'));
    }
  }
}

// 4) Cảnh báo JMA thay đổi (mọi lúc; ban đêm chỉ ≥ 危険警報)
{
  const prev = state.warn || {};
  const curMap = Object.fromEntries(warnings.list.map((w) => [w.code, w.level]));
  const minLv = awake ? 30 : 40;
  const fresh = warnings.list.filter((w) => !(w.code in prev) && (w.level >= minLv || (awake && IMMEDIATE_ADVISORY.includes(w.code))));
  const lifted = Object.keys(prev).filter((c) => !(c in curMap) && prev[c] >= 30);
  if (!isManual && !briefHasWarn && (fresh.length || (awake && lifted.length))) {
    const msg = [];
    if (fresh.length) msg.push(`🚨 <b>JMA phát cảnh báo cho Kariya</b>: ${warnLine(fresh)}`);
    if (warnings.headline && fresh.length) msg.push(esc(warnings.headline));
    if (awake && lifted.length) msg.push(`✅ Đã dỡ: ${lifted.map((c) => (W[c] || [c])[0]).join(', ')}`);
    parts.push(msg.join('\n'));
  }
  if (!isManual) state.warn = curMap;
}

// 5) Bão tiến gần (1 lần/ngày/cơn khi đang thức)
if (!isManual && awake) {
  for (const t of typhoons.filter((x) => x.risk === 'high' && x.soon)) {
    if (state.tc[t.key] === today) continue;
    state.tc[t.key] = today;
    if (!parts.some((p) => p.includes('🌀'))) parts.push(`🌀 <b>Bão có thể ảnh hưởng Kariya</b>\n${t.text}\nChuẩn bị: cất đồ ban công, sạc pin, nước + đèn pin, theo dõi JMA.`);
  }
}

// 6) Sắp mưa trong 1–2 giờ tới (khi ở nhà & đang thức)
if (!isManual && dataOk && awake && !(isWorkday(today) && nowMin >= CFG.atWork[0] && nowMin < CFG.atWork[1])) {
  const idx = H.findIndex((x) => x.t === now.toFormat("yyyy-MM-dd'T'HH:00"));
  const cur = H[idx];
  const next = H.slice(idx + 1, idx + 3);
  const hit = next.find((x) => (x.precipitation || 0) >= 1 && (x.precipitation_probability || 0) >= 60);
  const thunder = next.find((x) => (x.weather_code || 0) >= 95);
  const last = state.cooldown.rainSoon || 0;
  if (idx >= 0 && (cur.precipitation || 0) < 0.2 && (hit || thunder) && Date.now() - last > CFG.rainSoonCooldownH * 3600e3) {
    const x = hit || thunder;
    state.cooldown.rainSoon = Date.now();
    parts.push(`${thunder ? '⛈' : '🌧'} Sắp mưa khoảng ${x.h}h (${x.precipitation_probability}%, ${r1(x.precipitation || 0)}mm/h) — cất đồ phơi, đóng cửa sổ.`);
  }
}

if (!parts.length) return [];
return [{ json: { text: (isManual ? '🧪 TEST\n' : '') + parts.join('\n\n'), slot } }];
