// NotebookLM Daily Digest replacement — no browser cookies, no local machine dependency.
// Runs on GitHub Actions (or locally for testing): ดึงหัวข่าว 7 วันล่าสุดจาก Google News RSS (ฟรี ไม่ต้องใช้คีย์)
// แล้วให้ DeepSeek สรุป (สำรอง Groq) 6 หัวข้อ ส่ง LINE วันละครั้ง
// 💸 11ต.ค.69 เลิกใช้ Gemini + Google Search grounding (เครดิตหมด + เงื่อนไข grounding ห้ามเก็บลิงก์/ต้องโชว์ Search Suggestions)
const fs = require("fs");
const path = require("path");

const PROVIDERS = [
  { name: "deepseek", url: "https://api.deepseek.com/chat/completions", key: process.env.DEEPSEEK_API_KEY, model: "deepseek-chat" },
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: process.env.GROQ_API_KEY, model: "qwen/qwen3.8-27b", extra: { reasoning_effort: "none" } },
].filter(p => p.key);
const LINE_NOTIFY_URL = process.env.LINE_NOTIFY_URL;
const LINE_NOTIFY_KEY = process.env.LINE_NOTIFY_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const DIGEST_BASE_URL = process.env.DIGEST_BASE_URL || ""; // e.g. https://github.com/OWNER/daily-digest/blob/main/digests

if (!PROVIDERS.length) {
  console.error("Missing DEEPSEEK_API_KEY / GROQ_API_KEY");
  process.exit(1);
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD
const todayThai = new Date().toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" }); // 13 กันยายน 2569

const TOPICS = [
  { name: "📊 ราคาทอง และสินทรัพย์ GPF",
    query: "ราคาทองคำ OR กบข.",
    ask: "สรุปสถานการณ์ราคาทองคำและสินทรัพย์ลงทุน (กบข.) ล่าสุดวันนี้แบบกระชับ เน้นตัวเลขสำคัญและทิศทางที่ควรระวัง" },
  { name: "📋 ข่าว-ระเบียบ ศธ. สพฐ.",
    query: "สพฐ. OR กระทรวงศึกษาธิการ",
    ask: "สรุปข่าว/ระเบียบ/นโยบายล่าสุดจากกระทรวงศึกษาธิการและ สพฐ. ที่ครูควรรู้ แบบกระชับเป็นข้อๆ" },
  { name: "🤖 เทคโนโลยี-AI การศึกษา",
    query: "AI การศึกษา",
    ask: "สรุปข่าวเทคโนโลยี/AI ด้านการศึกษาที่น่าสนใจล่าสุด เน้นสิ่งที่ครูเอาไปใช้สอนได้จริง" },
  { name: "🌍 สถานการณ์โลก",
    query: "ข่าวต่างประเทศ",
    ask: "สรุปสถานการณ์โลกสำคัญล่าสุดแบบกระชับ ที่ส่งผลกระทบต่อไทยหรือควรติดตาม" },
  { name: "🦠 โรคระบาด-โรคอุบัติใหม่",
    query: "โรคระบาด OR โรคอุบัติใหม่",
    ask: "สรุปสถานการณ์โรคระบาด/โรคอุบัติใหม่ล่าสุดแบบกระชับ ที่ควรเฝ้าระวัง" },
  { name: "📈 หุ้นทั่วโลก",
    query: "ตลาดหุ้นโลก OR ดาวโจนส์",
    ask: "สรุปสถานการณ์ตลาดหุ้นทั่วโลกล่าสุดแบบกระชับ เน้นดัชนีสำคัญและทิศทาง" },
];

// ถาม AI ทีละค่าย — ค่ายแรกพัง/ติดลิมิต/ตอบว่าง ค่อยไปค่ายถัดไป
async function chat(prompt, maxTokens = 1500) {
  let last;
  for (const p of PROVIDERS) {
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ model: p.model, ...(p.extra || {}), temperature: 0.3, max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!res.ok || !text) throw new Error(`${p.name} HTTP ${res.status}: ${JSON.stringify(json.error || json).slice(0, 200)}`);
      return text;
    } catch (err) { last = err; console.error(`  ${p.name}: ${err.message}`); }
  }
  throw last;
}

// หัวข่าวจาก Google News RSS (when:7d = ภายใน 7 วัน) → [{title, source, date}] กรองวันที่ซ้ำอีกชั้น
function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
}
async function fetchNews(query, max = 15) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + " when:7d")}&hl=th&gl=TH&ceid=TH:th`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Google News RSS HTTP ${res.status}`);
  const xml = await res.text();
  const cutoff = Date.now() - 7.5 * 86400e3;
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = tag => (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || "";
    const t = Date.parse(g("pubDate"));
    if (!t || t < cutoff) continue;
    const source = decodeXml(g("source"));
    let title = decodeXml(g("title"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    out.push({ title, source, date: new Date(t).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit" }) });
    if (out.length >= max) break;
  }
  return out;
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
    // ให้วันที่ทั้ง พ.ศ. และ ค.ศ. + บังคับตัดข่าวเก่า — เคยเจอ grounding ดึงข่าวปีก่อนมาปน
    // (13 ก.ย. 69: "อนุทินขึ้นนายกฯ ก.ย." ซึ่งเป็นข่าว ก.ย. 68 เพราะคำว่า "กันยายน" ตรงกันทั้ง 2 ปี)
    const news = await withRetry(() => fetchNews(topic.query), topic.name + " RSS");
    if (!news.length) {
      const none = "ไม่มีความเคลื่อนไหวใหม่ใน 7 วันที่ผ่านมา";
      return { name: topic.name, success: true, full: none, highlight: none };
    }
    const list = news.map((n, i) => `${i + 1}. ${n.title} — ${n.source} (${n.date})`).join("\n");
    const prompt =
      `วันนี้คือ ${todayThai} (ค.ศ. ${today}) ต่อไปนี้คือหัวข่าวล่าสุดจาก Google News เกี่ยวกับ: ${topic.query}\n\n${list}\n\n${topic.ask}\n\n` +
      `ใช้เฉพาะข้อมูลในหัวข่าวด้านบนเท่านั้น ห้ามแต่งตัวเลขหรือรายละเอียดที่ไม่มีในหัวข่าว · หัวข่าวที่ซ้ำเรื่องเดียวกันให้รวมเป็นข้อเดียว · ข้ามหัวข่าวที่ไม่เกี่ยวกับหัวข้อ · เขียนเป็นข้อๆ 3-6 ข้อ · เริ่มที่ข้อแรกเลย ห้ามเขียนอารัมภบท ห้ามพูดถึง "หัวข่าวที่ให้มา\"\n\n` +
      `กฎเรื่องความสดของข่าว (สำคัญมาก):\n` +
      `- ใช้เฉพาะข่าว/ข้อมูลที่เผยแพร่หรือเกิดขึ้นภายใน 7 วันก่อน ${todayThai} เท่านั้น\n` +
      `- ตรวจปีของแหล่งข่าวทุกชิ้น ระวังข่าวเดือนเดียวกันของปีก่อน ถ้าไม่แน่ใจวันที่หรือเก่ากว่า 7 วัน ให้ตัดทิ้ง ห้ามนำมาใช้\n` +
      `- เหตุการณ์ที่มีวันที่ก่อน ${todayThai} คืออดีตแล้ว ห้ามเขียนเหมือนยังไม่เกิด\n` +
      `- ท้ายแต่ละข้อใส่วันที่ของข่าวในวงเล็บ เช่น (12 ก.ย. 69)\n` +
      `- ถ้าหัวข้อนี้ไม่มีข่าวใหม่ใน 7 วัน ให้บอกตรงๆ ว่าไม่มีความเคลื่อนไหวใหม่`;
    const full = await withRetry(() => chat(prompt), topic.name);
    const highlightPrompt =
      `ต่อไปนี้คือเนื้อข่าวภาษาไทย จงเขียนสรุปเป็นภาษาไทย 1 ประโยคสั้นกระชับ ไม่เกิน 140 ตัวอักษร ` +
      `เน้นตัวเลข/ชื่อ/เหตุการณ์เด่นที่สุดในเนื้อข่าวนี้เท่านั้น ห้ามคำนวณเลขใดๆ ห้ามตอบเป็นภาษาอื่น ` +
      `ห้ามมีเลขอ้างอิงแบบ [1] ตอบเฉพาะประโยคสรุป ไม่ต้องมีคำนำ:\n\n${full}`;
    let highlight = null;
    for (let i = 0; i < 2 && !highlight; i++) {
      try {
        const hlRaw = await chat(highlightPrompt, 300);
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
  const results = [];
  let successCount = 0;

  for (const topic of TOPICS) {
    console.log(`--- [${topic.name}] ---`);
    const result = await digestTopic(topic);
    results.push(result);
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

  // รายการวันที่ให้แถบ "ข่าวย้อนหลัง" ใน news.html (อ่านจาก raw ตรงๆ ไม่ใช้ GitHub API ที่จำกัด 60 ครั้ง/ชม.ต่อ IP — ทั้งโรงเรียนออกเน็ต IP เดียว)
  const dates = fs.readdirSync(outDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map(f => f.slice(0, 10)).sort().reverse();
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(dates), "utf8");

  // แท็บ Gemini ใน bangkho.ac.th/home/news.html + แถบข่าววิ่งหน้าแรกอ่านไฟล์นี้
  // พังหมดทุกหัวข้อ (เช่นชนเพดาน 429) = ไม่เขียนทับ เว็บจะโชว์ของล่าสุดที่ดีแทนข้อความ error
  if (successCount > 0) {
    const latest = {
      date: today,
      generated_at: new Date().toISOString(),
      topics: results.filter(r => r.success).map(r => ({ name: r.name, highlight: r.highlight, full: r.full })),
    };
    fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latest, null, 1), "utf8");
    fs.writeFileSync(path.join(outDir, `${today}.json`), JSON.stringify(latest, null, 1), "utf8"); // เก็บสรุปย่อไว้ดูย้อนหลัง (.md ไม่มีสรุปย่อ)
  }

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
