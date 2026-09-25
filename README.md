# Weather tracker – Kariya 448-0003

Workflow n8n nhắc thời tiết qua Telegram cho khu 刈谷市一ツ木町 (448-0003).
**Im lặng khi không có gì bất thường**, chỉ nhắn khi có điều cần làm.

## Kiến trúc

```
Every 15 min ─┐
Test now ─────┴─► Open-Meteo Forecast ► Open-Meteo Air Quality ► JMA Warnings (r8)
                  ► JMA Forecast (降水確率) ► JMA Typhoon List ► JMA Typhoon Details
                  ► Analyze & Decide (Code, rule-based) ► Send Telegram
```

```
Daily 12:05 ─► Aichi Weekly Index ► Pick Latest Weeks ► Download Weekly Excel
             ► Extract Excel ► Analyze Infection ─► Send Telegram
```

- Mọi HTTP node thời tiết: `onError: continueRegularOutput` + retry, nên một nguồn chết không làm hỏng cả flow.
- Không dùng LLM: logic là rule cố định, chạy nhanh, không tốn tiền, không bị "bịa".
- State (đã gửi brief chưa, cảnh báo đã biết, cooldown) lưu bằng `$getWorkflowStaticData` → **chỉ lưu khi workflow Active** (production run).

## Lịch nhắn (JST)

| Thời điểm | Nội dung | Điều kiện gửi |
|---|---|---|
| 06:45 (T2–T6) / 08:00 (T7–CN) | Brief sáng: ô, gió, nóng/lạnh, UV, độ ẩm, PM2.5/黄砂, cảnh báo JMA, bão, giặt đồ | Có mục mức ≥2, hoặc ≥2 mục mức 1, hoặc có cảnh báo/bão, hoặc hôm nay phơi đồ rất tốt sau ≥2 ngày ẩm |
| 16:00 (T2–T6) | Mưa/gió giờ về 17–20h | Có mưa mà sáng chưa nhắc ô, hoặc gió giật ≥15 m/s |
| 21:00 | Preview ngày mai + việc cần làm tối nay | Mai có mục mức ≥2, bão ≤72h, hoặc đêm nay mưa |
| Bất kỳ lúc nào | JMA 警報/注意報 mới cho 刈谷市 | Đang thức: ≥警報 + 大雨/土砂/雷/強風注意報. Ban đêm (23:00–6:30): chỉ ≥危険警報 |
| Bất kỳ lúc nào (khi thức) | Bão: Kariya nằm trong 暴風警戒域 dự báo trong ≤72h | 1 lần/ngày/cơn |
| Khi ở nhà (ngoài 7:30–17:00 ngày làm việc) | Sắp mưa trong 1–2h → cất đồ, đóng cửa sổ | Cooldown 6h |

## Dịch bệnh hô hấp (nhánh Daily 12:05)

Nguồn: 愛知県衛生研究所 – file Excel tuần `kansen/YYYY/YYYYWW.xlsx` (định điểm theo 保健所).
Kariya thuộc **衣浦東部保健所**. Mỗi ngày 12:05 kiểm tra có tuần mới không; có thì tải 2 tuần gần nhất, tính số ca/定点:

| Bệnh | Cơ sở | Mức 1 / 2 / 3 |
|---|---|---|
| Cúm | ARI定点, 衣浦東部 | 1 (流行入り) / 10 (注意報) / 30 (警報) – chuẩn quốc gia |
| COVID-19 | ARI定点, 衣浦東部 | 5 / 10 / 20 |
| マイコプラズマ肺炎 | 基幹定点, toàn tỉnh | 1 / 2 / 4 |
| 感染性胃腸炎 (ノロ等) | 小児科定点, 衣浦東部 | 8 / 12 / 20 |
| ARI chung | ARI定点 | báo khi tăng ≥30% so với tuần trước |

- Kết quả lưu vào `staticData.infection`; brief sáng thêm dòng 🦠 khi có bệnh ở mức ≥1 (nâng mức nếu không khí khô).
- Nhắn riêng khi mức thay đổi, ARI tăng vọt, hoặc có bệnh mức ≥2.

## Báo lỗi

- Workflow **Error notifier** (Error Trigger → Telegram) được gắn làm `errorWorkflow`. Cùng lỗi chỉ báo 1 lần / 3h (kèm số lần lặp bị ẩn).
- Nhánh dịch bệnh cố ý `throw` khi trang/Excel đổi cấu trúc hoặc số liệu cũ >21 ngày → báo qua Error notifier.
- Nguồn thời tiết lỗi liên tục ≥1h (4 lần chạy) → Analyze tự nhắn ⚠️, và nhắn ✅ khi hồi phục.
- Không bắt được trường hợp cả n8n chết → cần heartbeat bên ngoài (vd. healthchecks.io) nếu muốn.

## Ngưỡng chính

| Mục | Ngưỡng |
|---|---|
| Mang ô | Mưa ≥0.3mm/h hoặc xác suất ≥50% trong giờ ra ngoài, hoặc JMA 降水確率 ≥50% |
| Mưa to | ≥10mm/h (≥20mm/h: đề phòng ngập) |
| Gió | Giật ≥12 / 15 / 20 m/s |
| Nóng | WBGT ước tính (công thức 小野) ≥25 / 28 / 31, hoặc ≥35°C |
| Lạnh | Min ≤5°C / ≤0°C; max chênh ≥5°C so với hôm trước |
| UV | ≥8 ngày làm việc, ≥6 cuối tuần, ≥11 cực mạnh |
| Hô hấp | Độ ẩm tuyệt đối <7 g/m³ (cúm dễ lây), PM2.5 ≥35 / ≥70 µg/m³, dust ≥50 µg/m³ |
| Giặt đồ | Mưa/ô nhiễm → phơi trong nhà; RH ≥80% → khô chậm; RH ≤65% + nắng/gió → rất tốt |

Tất cả chỉnh ở khối `CFG` và các hằng số trong `n8n/analyze.js` (copy vào Code node).

## Nguồn dữ liệu

- **Open-Meteo Forecast** (không cần key; best_match ở Nhật dùng model JMA MSM/GSM) – theo giờ.
- **Open-Meteo Air Quality** (CAMS) – PM2.5, dust.
- **JMA bosai** – cảnh báo theo 防災気象情報 mới (từ 29/5/2026, endpoint `/bosai/warning/data/r8/`), 降水確率 愛知県西部, thông tin bão.
  Endpoint cũ `/bosai/warning/data/warning/230000.json` đã dừng cập nhật từ 28/5/2026.

## Files

- `n8n/analyze.js` – code của node *Analyze & Decide* (source of truth).
- `n8n/infection-pick.js`, `n8n/infection-analyze.js` – code nhánh dịch bệnh.
- `n8n/error-notify.js` – code của Error notifier.
- `n8n/*.workflow.json` – export workflow để import lại (sau khi import: gán credential Telegram, set Error Workflow).
