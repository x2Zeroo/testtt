require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.MODEL || 'google/gemini-2.0-flash-exp:free';

// ─── Temp file cache for downloads (2hr expiry) ───────────────────────────────
const fileCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, f] of fileCache) {
    if (f.expires < now) fileCache.delete(token);
  }
}, 30 * 60 * 1000);

// ─── Accept ALL file types, up to 50MB, 10 files ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: DEFAULT_MODEL, hasKey: !!OPENROUTER_API_KEY });
});

// ─── Models (ALL from OpenRouter) ────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key' });
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    });
    const data = await r.json();
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      context_length: m.context_length || 0,
      pricing: m.pricing || {},
      free: m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'),
      description: m.description || '',
    }));
    // Free models first, then alphabetical
    models.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json(models);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Download generated files ─────────────────────────────────────────────────
app.get('/api/download/:token', (req, res) => {
  const f = fileCache.get(req.params.token);
  if (!f) return res.status(404).send('ไฟล์หมดอายุหรือไม่พบ (2 ชั่วโมง)');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(f.buffer);
});

// ─── System Prompt with Skills ────────────────────────────────────────────────
const SYSTEM_PROMPT = `คุณเป็น AI assistant ที่ทรงพลังและฉลาดมาก มีทักษะหลายด้าน:

🔬 **วิเคราะห์ (Analysis)** — วิเคราะห์อย่างเป็นระบบ หาสาเหตุ ผลกระทบ จุดอ่อน/จุดแข็ง
🗺️ **วางแผน (Planning)** — สร้างแผนงานที่ชัดเจน มีขั้นตอน timeline และปฏิบัติได้จริง
🧠 **คิดเชิงลึก (Deep Thinking)** — พิจารณาหลายมุมมอง ชั่งน้ำหนักตัวเลือก หาข้อสรุปที่ดีที่สุด
💻 **แก้ไขโค้ด (Code Editing)** — วิเคราะห์ แก้ไข และปรับปรุงโค้ดทุกภาษาได้อย่างแม่นยำ

## 📁 กฎสำหรับการแก้ไขไฟล์โค้ด (สำคัญมาก):
เมื่อผู้ใช้ส่งไฟล์โค้ดและขอให้แก้ไข/ปรับปรุง/เพิ่มฟีเจอร์ ต้องส่งคืนไฟล์ที่แก้ไขแล้วในรูปแบบนี้เสมอ:

[FILE:ชื่อไฟล์.นามสกุล]
เนื้อหาไฟล์ที่แก้ไขแล้วทั้งหมด (ครบทุกบรรทัด ไม่ตัดทอน)
[/FILE]

— ส่งคืนทุกไฟล์ที่แก้ไข สามารถมีหลาย [FILE:...][/FILE] ในคำตอบเดียว
— ใส่เนื้อหาไฟล์ให้ครบสมบูรณ์ ไม่ใช่แค่ส่วนที่แก้
— หลัง [FILE] blocks ให้สรุปสิ่งที่แก้ไขไปบ้าง

ตอบเป็นภาษาไทยหรืออังกฤษตามที่ผู้ใช้ถาม`;

// ─── File helpers ─────────────────────────────────────────────────────────────
const TEXT_EXTS = new Set([
  'js','ts','jsx','tsx','mjs','cjs','vue','svelte',
  'py','rb','php','pl','lua','r','go','rs','swift','kt','dart',
  'java','c','cpp','h','hpp','cs','scala','ex','exs','clj','elm',
  'html','htm','css','scss','sass','less',
  'json','xml','yaml','yml','toml','ini','cfg','conf','env',
  'md','txt','csv','tsv','sql','sh','bash','zsh','fish','ps1',
  'dockerfile','makefile','gitignore','editorconfig',
  'tf','hcl','proto',
]);

function isTextFile(mimetype, filename) {
  if (mimetype.startsWith('text/')) return true;
  if (mimetype.startsWith('image/') || mimetype === 'application/pdf') return false;
  const ext = path.extname(filename).replace('.', '').toLowerCase();
  return TEXT_EXTS.has(ext);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
app.post('/api/chat', upload.array('files', 10), async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY ใน .env' });
    }

    const { message, history, model, skill } = req.body;
    const files = req.files || [];
    const selectedModel = model || DEFAULT_MODEL;

    if (!message && files.length === 0) {
      return res.status(400).json({ error: 'กรุณาส่งข้อความหรือไฟล์' });
    }

    const content = [];

    // ── Process uploaded files ──
    for (const file of files) {
      if (file.mimetype.startsWith('image/')) {
        const b64 = file.buffer.toString('base64');
        content.push({ type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${b64}` } });
        content.push({ type: 'text', text: `📸 รูปภาพ: ${file.originalname} (${humanSize(file.size)})` });
      } else if (isTextFile(file.mimetype, file.originalname)) {
        const text = file.buffer.toString('utf-8');
        const ext = path.extname(file.originalname).slice(1);
        const truncated = text.length > 15000;
        content.push({
          type: 'text',
          text: `📄 ไฟล์: ${file.originalname} (${humanSize(file.size)})\n\`\`\`${ext}\n${text.slice(0, 15000)}${truncated ? '\n...(ตัดทอนเนื่องจากไฟล์ยาวเกิน)' : ''}\n\`\`\``,
        });
      } else {
        // Binary — show metadata only
        content.push({
          type: 'text',
          text: `📦 ไฟล์ไบนารี: ${file.originalname} | ประเภท: ${file.mimetype} | ขนาด: ${humanSize(file.size)}`,
        });
      }
    }

    // ── Apply skill prefix ──
    let userMessage = message || '';
    switch (skill) {
      case 'plan':
        userMessage = `🗺️ [โหมดวางแผน] โปรดสร้างแผนงานโดยละเอียด มีขั้นตอนชัดเจน ลำดับความสำคัญ และ timeline:\n\n${userMessage}`;
        break;
      case 'think':
        userMessage = `🧠 [โหมดคิดเชิงลึก] โปรดคิดวิเคราะห์อย่างรอบด้าน พิจารณาหลายมุมมอง ชั่งน้ำหนักข้อดีข้อเสีย และให้ข้อสรุปที่รอบคอบ:\n\n${userMessage}`;
        break;
      case 'analyze':
        userMessage = `🔬 [โหมดวิเคราะห์] โปรดวิเคราะห์อย่างเป็นระบบ หาสาเหตุ ผลกระทบ จุดอ่อน จุดแข็ง โอกาส และข้อเสนอแนะที่ปฏิบัติได้:\n\n${userMessage}`;
        break;
      case 'code':
        userMessage = `💻 [โหมดแก้ไขโค้ด] โปรดวิเคราะห์และแก้ไขโค้ดอย่างละเอียด ส่งคืนไฟล์ที่แก้ไขแล้วในรูปแบบ [FILE:ชื่อไฟล์]...[/FILE] ครบทุกไฟล์:\n\n${userMessage}`;
        break;
    }

    if (userMessage) content.push({ type: 'text', text: userMessage });

    let conversationHistory = [];
    try { conversationHistory = history ? JSON.parse(history) : []; } catch (_) {}

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content },
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `http://localhost:${PORT}`,
        'X-Title': 'AI Chat Pro',
      },
      body: JSON.stringify({ model: selectedModel, max_tokens: 8192, messages }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    const rawReply = data.choices?.[0]?.message?.content || '(ไม่มีคำตอบ)';

    // ── Parse [FILE:name]...[/FILE] blocks ──
    const downloads = [];
    const fileRegex = /\[FILE:([^\]]+)\]([\s\S]*?)\[\/FILE\]/g;
    let match;
    while ((match = fileRegex.exec(rawReply)) !== null) {
      const fname = match[1].trim();
      const fContent = match[2].replace(/^\n/, '').replace(/\n$/, '');
      const token = crypto.randomBytes(20).toString('hex');
      fileCache.set(token, {
        name: fname,
        buffer: Buffer.from(fContent, 'utf-8'),
        expires: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
      });
      downloads.push({ name: fname, token });
    }

    // Remove [FILE:...][/FILE] from display
    const cleanReply = rawReply.replace(/\[FILE:[^\]]+\][\s\S]*?\[\/FILE\]/g, '').trim();
    const displayReply = cleanReply || (downloads.length > 0 ? '✅ แก้ไขไฟล์เสร็จแล้ว — ดาวน์โหลดได้ด้านล่าง' : '(ไม่มีคำตอบ)');

    res.json({
      message: displayReply,
      model: data.model || selectedModel,
      downloads,
      usage: data.usage || null,
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 AI Chat Pro รันที่ http://localhost:${PORT}`);
  console.log(`🤖 โมเดลเริ่มต้น: ${DEFAULT_MODEL}`);
  if (!OPENROUTER_API_KEY) console.warn('⚠️  ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY ใน .env');
});
