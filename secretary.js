// Personal Secretary — daily Google Calendar digest pushed to LINE.
// Runs on GitHub Actions, no dependency on the local Windows machine.
// MODE=tonight  -> runs ~18:00 Asia/Bangkok, summarizes TOMORROW + upcoming deadlines (3 days)
// MODE=morning  -> runs ~06:00 Asia/Bangkok, summarizes TODAY + upcoming deadlines (3 days)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const LINE_NOTIFY_URL = process.env.LINE_NOTIFY_URL;
const LINE_NOTIFY_KEY = process.env.LINE_NOTIFY_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const MODE = process.env.MODE || "morning"; // "morning" | "tonight"

const TZ = "Asia/Bangkok";
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
// เดียวกับ AUTO_EXCLUDE_TITLES ใน portal_gas — "สำนักงาน" คือ recurring block เวลาทำงานปกติ ไม่ใช่นัดหมายจริง
const AUTO_EXCLUDE_TITLES = ["สำนักงาน"];
// supSummary API ของระบบนิเทศการสอน (bklive-timetable) — byDate keyed "YYYY-MM-DD", กรองด้วย supervisee_id
const SUP_API_URL = "https://script.google.com/macros/s/AKfycbwR_jmt3cY2cobLlbmn0BgXSaTaKrj4TIVe0z72yr1t6abHZWBNIG1xkTwIoNnnj2rs/exec?action=supSummary";
const MY_TEACHER_ID = "T013";

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error("Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN");
  process.exit(1);
}

function bangkokDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
  }).formatToParts(date);
  const get = (t) => parts.find(p => p.type === t).value;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

function thaiDateLabel(date) {
  const { y, m, d } = bangkokDateParts(date);
  const weekday = THAI_DAYS[date.getUTCDay()] || "";
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}

// Midnight-to-midnight Asia/Bangkok range for a given day offset from "now" (0=today, 1=tomorrow)
function dayRangeBangkok(offsetDays) {
  const now = new Date();
  const { y, m, d } = bangkokDateParts(now);
  // Asia/Bangkok has no DST, fixed UTC+7 — safe to construct offsets directly.
  const startUtc = new Date(Date.UTC(y, m - 1, d + offsetDays, -7, 0, 0));
  const endUtc = new Date(Date.UTC(y, m - 1, d + offsetDays + 1, -7, 0, 0));
  return { start: startUtc, end: endUtc, label: thaiDateLabel(startUtc), isoDate: isoDateOf(y, m, d + offsetDays) };
}

function isoDateOf(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  if (!res.ok) throw new Error(`token refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error(`token refresh returned no access_token: ${JSON.stringify(json).slice(0, 300)}`);
  return json.access_token;
}

async function listEvents(accessToken, start, end) {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeZone", TZ);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`calendar list HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const items = json.items || [];
  return items.filter(ev => !AUTO_EXCLUDE_TITLES.includes((ev.summary || "").trim()));
}

function formatEventLine(ev) {
  const title = ev.summary || "(ไม่มีชื่อกิจกรรม)";
  const mark = title.includes("สอบ") ? "📝 " : ""; // เตือนชัดๆ ถ้าเป็นเรื่องสอบ
  if (ev.start.date) return `• ${mark}(ทั้งวัน) ${title}`;
  const time = new Date(ev.start.dateTime).toLocaleTimeString("th-TH", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false
  });
  const loc = ev.location ? ` @ ${ev.location}` : "";
  return `• ${mark}${time} ${title}${loc}`;
}

function formatEventBlock(events) {
  if (!events.length) return "(ไม่มีนัดหมาย)";
  return events.map(formatEventLine).join("\n");
}

// ดึงตารางนิเทศทั้งหมดครั้งเดียว (repo bklive-timetable) แล้วกรองด้วย MY_TEACHER_ID ในแต่ละวันเอง
async function fetchSupervisionByDate() {
  try {
    const res = await fetch(SUP_API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.byDate || {};
  } catch (err) {
    console.error(`supSummary fetch failed: ${err.message}`);
    return {};
  }
}

function mySupervisionOn(byDate, isoDate) {
  return (byDate[isoDate] || []).filter(item => item.supervisee_id === MY_TEACHER_ID);
}

function formatSupervisionLine(item) {
  return `• 🔍 คาบ ${item.period} วิชา${item.subject_name} (${item.class_name}) — ${item.role_th} ${item.supervisor_name}`;
}

function formatSupervisionBlock(items) {
  if (!items.length) return null;
  return items.map(formatSupervisionLine).join("\n");
}

async function sendLineNotify(text) {
  if (DRY_RUN) {
    console.log("--- DRY RUN: would send LINE ---\n" + text);
    return;
  }
  if (!LINE_NOTIFY_URL || !LINE_NOTIFY_KEY) {
    console.error("Missing LINE_NOTIFY_URL/LINE_NOTIFY_KEY, skipping LINE notify");
    return;
  }
  const url = `${LINE_NOTIFY_URL}?action=notify&key=${LINE_NOTIFY_KEY}&text=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    console.log(`LINE notify status: ${res.status}`);
  } catch (err) {
    console.error(`LINE notify failed: ${err.message}`);
  }
}

async function main() {
  const accessToken = await getAccessToken();

  const isTonight = MODE === "tonight";
  const mainDay = dayRangeBangkok(isTonight ? 1 : 0);
  const mainEvents = await listEvents(accessToken, mainDay.start, mainDay.end);

  // "งานใกล้ครบกำหนด" window: next 3 days after the main day (per OS plan section 3.3)
  const upcomingDayOffsets = isTonight ? [2, 3, 4] : [1, 2, 3];
  const upcomingStart = dayRangeBangkok(upcomingDayOffsets[0]).start;
  const upcomingEnd = dayRangeBangkok(upcomingDayOffsets[upcomingDayOffsets.length - 1]).end;
  const upcomingEvents = await listEvents(accessToken, upcomingStart, upcomingEnd);

  const byDate = await fetchSupervisionByDate();
  const mySupToday = mySupervisionOn(byDate, mainDay.isoDate);
  const upcomingSup = upcomingDayOffsets
    .map(off => dayRangeBangkok(off))
    .flatMap(day => mySupervisionOn(byDate, day.isoDate).map(item => ({ ...item, dayLabel: day.label })));

  const header = isTonight
    ? `🌙 สรุปพรุ่งนี้ (${mainDay.label})`
    : `🌅 สรุปวันนี้ (${mainDay.label})`;

  let text =
    `${header}\n` +
    `━━━━━━━━━━\n` +
    `${formatEventBlock(mainEvents)}\n`;

  const mySupTodayBlock = formatSupervisionBlock(mySupToday);
  if (mySupTodayBlock) {
    text += `━━━━━━━━━━\n🔍 มีนิเทศการสอน!\n${mySupTodayBlock}\n`;
  }

  text += `━━━━━━━━━━\n📌 งานใกล้ครบกำหนด (3 วันข้างหน้า):\n${formatEventBlock(upcomingEvents)}`;

  if (upcomingSup.length) {
    text += `\n\n🔍 นิเทศที่จะถึง:\n` +
      upcomingSup.map(item => `• ${item.dayLabel}: ${formatSupervisionLine(item).slice(2)}`).join("\n");
  }

  console.log(text);
  await sendLineNotify(text);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
