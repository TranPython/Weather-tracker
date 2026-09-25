// Code node "Pick Latest Weeks" – chọn 2 file Excel tuần mới nhất trên trang 愛知県衛生研究所.
// Lỗi ở đây được throw để Error notifier báo qua Telegram.
const state = $getWorkflowStaticData('global');
const manual = $execution.mode !== 'production';
const html = String($input.first().json.data || '');

// Trang dùng Shift-JIS nhưng link là ASCII nên regex vẫn chạy được
const weeks = [...new Set([...html.matchAll(/kansen\/(\d{4})\/(\d{6})\.xlsx/g)].map((m) => m[2]))].sort();
if (!weeks.length) throw new Error('Aichi kansen.html: không tìm thấy link Excel tuần (trang đổi cấu trúc?)');

const inf = state.infection;
if (inf && inf.end) {
  const ageDays = (Date.now() - new Date(inf.end + 'T00:00:00+09:00').getTime()) / 864e5;
  if (ageDays > 21) throw new Error(`Aichi: số liệu dịch bệnh mới nhất đã cũ ${Math.round(ageDays)} ngày (tuần ${inf.week}) — nguồn ngừng cập nhật?`);
}

const latest = weeks.slice(-2);
if (!manual && inf && inf.week === latest[latest.length - 1]) return []; // chưa có tuần mới
return latest.map((w) => ({ json: { week: w, url: `https://www.pref.aichi.jp/eiseiken/kansen/${w.slice(0, 4)}/${w}.xlsx` } }));
