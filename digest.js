// NotebookLM Daily Digest replacement — no browser cookies, no local machine dependency.
// Runs on GitHub Actions (or locally for testing) using the Gemini API (real API key auth)
// with Google Search grounding to research 6 topics, then sends one LINE summary/day.
const fs = require("fs");
const path = require("path");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_NOTIFY_URL = process.env.LINE_NOTIFY_URL;
const LINE_NOTIFY_KEY = process.env.LINE_NOTIFY_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const DIGEST_BASE_URL = process.env.DIGEST_BASE_URL || ""; // e.g. https://github.com/OWNER/daily-digest/blob/main/digests

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD

const TOPICS = [
  { name: "📊 ราคาทอง และสินทรัพย์ GPF",
    query: "ราคาทองคำล่าสุดวันนี้ แนวโน้มตลาดทอง กบข. สินทรัพย์ลงทุน",
    ask: "สรุปสถานการณ์ราคาทองคำและสินทรัพย์ลงทุน (กบข.) ล่าสุดวันนี้แบบกระชับ เน้นตัวเลขสำคัญและทิศทางที่ควรระวัง" },
  { name: "📋 ข่าว-ระเบียบ ศธ. สพฐ.",
    query: "ข่าวประกาศระเบียบล่าสุด กระทรวงศึกษาธิการ สพฐ. โรงเรียน",
    ask: "สรุปข่าว/ระเบียบ/นโยบายล่าสุดจากกระทรวงศึกษาธิการและ สพฐ. ที่ครูควรรู้ แบบกระชับเป็นข้อๆ" },
  { name: "🤖 เทคโนโลยี-AI การศึกษา",
    query: "ข่าวเทคโนโลยี AI การศึกษา เครื่องมือสอนใหม่",
    ask: "สรุปข่าวเทคโนโลยี/AI ด้านการศึกษาที่น่าสนใจล่าสุด เน้นสิ่งที่ครูเอาไปใช้สอนได้จริง" },
  { name: "🌍 สถานการณ์โลก",
    query: "ข่าวสถานการณ์โลกสำคัญล่าสุด",
    ask: "สรุปสถานการณ์โลกสำคัญล่าสุดแบบกระชับ ที่ส่งผลกระทบต่อไทยหรือควรติดตาม" },
  { name: "🦠 โรคระบาด-โรคอุบัติใหม่",
    query: "ข่าวโรคระบาด โรคอุบัติใหม่ ล่าสุด สถานการณ์ในไทยและโลก",
    ask: "สรุปสถานการณ์โรคระบาด/โรคอุบัติใหม่ล่าสุดแบบกระชับ ที่ควรเฝ้าระวัง" },
  { name: "📈 หุ้นทั่วโลก",
    query: "ข่าวสถานการณ์ตลาดหุ้นทั่วโลก ดัชนีสำคัญ ล่าสุด",
    ask: "สรุปสถานการณ์ตลาดหุ้นทั่วโลกล่าสุดแบบกระชับ เน้นดัชนีสำคัญและทิศทาง" },
];

const FULL_MODEL = "gemini-2.5-flash";

async function generateContent(model, prompt, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n");
  if (!text) throw new Error(`Gemini ${model} returned no text: ${JSON.stringify(json).slice(0, 300)}`);
  return text.trim();
}

const MAX_HIGHLIGHT_LEN = 155;

function cleanHighlight(raw) {
  let text = raw
    .replace(/\[[0-9,\s\-]+\]/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_HIGHLIGHT_LEN) {
    const cut = text.slice(0, MAX_HIGHLIGHT_LEN);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return text;
}

// Guards against the model occasionally going off-script on a non-grounded
// condensation call (observed once: a long bulleted list summarized into
// nonsense arithmetic like "+1+1+1...=10,000,000" instead of Thai text).
function looksLikeValidHighlight(text) {
  if (!text || text.length < 5) return false;
  const thaiChars = (text.match(/[฀-๿]/g) || []).length;
  return thaiChars >= Math.min(10, text.length * 0.2);
}

function firstSentenceFallback(full) {
  const plain = full.replace(/[*#]/g, "").replace(/\s+/g, " ").trim();
  const sentence = plain.split(/(?<=[.!?])\s|(?<=[ก-๙]\.)\s/)[0] || plain;
  return cleanHighlight(sentence);
}

async function withRetry(fn, label, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[${label}] attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, attempt * 8000));
    }
  }
  throw lastErr;
}

async function digestTopic(topic) {
  try {
    const full = await withRetry(
      () => generateContent(FULL_MODEL, `ค้นข้อมูลล่าสุดวันนี้ (${today}) เกี่ยวกับ: ${topic.query}\n\n${topic.ask}`, true),
      topic.name
    );
    const highlightPrompt =
      `ต่อไปนี้คือเนื้อข่าวภาษาไทย จงเขียนสรุปเป็นภาษาไทย 1 ประโยคสั้นกระชับ ไม่เกิน 140 ตัวอักษร ` +
      `เน้นตัวเลข/ชื่อ/เหตุการณ์เด่นที่สุดในเนื้อข่าวนี้เท่านั้น ห้ามคำนวณเลขใดๆ ห้ามตอบเป็นภาษาอื่น ` +
      `ห้ามมีเลขอ้างอิงแบบ [1] ตอบเฉพาะประโยคสรุป ไม่ต้องมีคำนำ:\n\n${full}`;
    let highlight = null;
    for (let i = 0; i < 2 && !highlight; i++) {
      try {
        const hlRaw = await generateContent(FULL_MODEL, highlightPrompt, false);
        const cleaned = cleanHighlight(hlRaw);
        if (looksLikeValidHighlight(cleaned)) highlight = cleaned;
      } catch (e) { /* retry or fall through to fallback below */ }
    }
    if (!highlight) highlight = firstSentenceFallback(full);
    return { name: topic.name, success: true, full, highlight };
  } catch (err) {
    console.error(`[${topic.name}] FAILED: ${err.message}`);
    return { name: topic.name, success: false, full: `(เกิดข้อผิดพลาด: ${err.message})`, highlight: `❌ ${topic.name} (ไม่สำเร็จ)` };
  }
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
  const sections = [`# สรุปข่าวประจำวัน Daily Digest — ${today}\n`];
  const highlights = [];
  let successCount = 0;

  for (const topic of TOPICS) {
    console.log(`--- [${topic.name}] ---`);
    const result = await digestTopic(topic);
    sections.push(`## ${result.name}\n`);
    sections.push(`${result.full}\n`);
    highlights.push(result.success ? `${result.name}\n${result.highlight}` : result.highlight);
    if (result.success) successCount++;
    await new Promise(r => setTimeout(r, 3000)); // small politeness delay between topics
  }

  const outDir = path.join(__dirname, "digests");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${today}.md`);
  fs.writeFileSync(outFile, sections.join("\n"), "utf8");
  console.log(`Saved digest to ${outFile}`);

  const fullLink = DIGEST_BASE_URL ? `${DIGEST_BASE_URL}/${today}.md` : outFile;
  const summaryText =
    `📋 [${today}] Daily Digest (${successCount}/${TOPICS.length})\n\n` +
    highlights.join("\n\n") +
    `\n\n📄 ฉบับเต็ม: ${fullLink}`;

  await sendLineNotify(summaryText);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
