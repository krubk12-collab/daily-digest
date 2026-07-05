# Daily Digest

สรุปข่าวประจำวัน 6 หัวข้อ (ทอง/กบข., ข่าว ศธ.สพฐ., เทค-AI การศึกษา, สถานการณ์โลก, โรคระบาด, หุ้นโลก) โดยใช้ Gemini API (Google Search grounding) รันอัตโนมัติทุกวันผ่าน GitHub Actions — ไม่พึ่ง browser cookie หรือเครื่องส่วนตัวใดๆ

- ผลลัพธ์เต็มถูก commit ไว้ที่ `digests/YYYY-MM-DD.md`
- สรุปไฮไลต์ถูกส่งเข้า LINE OA ทุกวัน 1 ข้อความ (ผ่าน endpoint ของ GPF Tracker Apps Script เดิม)
- รันตามตาราง cron ทุกวัน 10:00 น. (ไทย) หรือกด "Run workflow" (workflow_dispatch) เพื่อรันมือ/ทดสอบ

## Secrets ที่ต้องตั้งใน repo settings
- `GEMINI_API_KEY`
- `LINE_NOTIFY_URL`
- `LINE_NOTIFY_KEY`

## รันทดสอบในเครื่อง
```
GEMINI_API_KEY=xxx DRY_RUN=1 node digest.js
```
`DRY_RUN=1` จะพิมพ์ข้อความ LINE ออกทาง console แทนการส่งจริง
