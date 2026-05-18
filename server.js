require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.MODEL || 'google/gemini-2.0-flash-exp:free';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('text/') ||
        file.mimetype === 'application/pdf' || file.mimetype === 'application/json') {
      cb(null, true);
    } else {
      cb(new Error(`ไฟล์ประเภท ${file.mimetype} ไม่รองรับ`));
    }
  },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', upload.array('files', 5), async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY ใน .env' });
    }

    const { message, history } = req.body;
    const files = req.files || [];

    if (!message && files.length === 0) {
      return res.status(400).json({ error: 'กรุณาส่งข้อความหรือไฟล์' });
    }

    const content = [];

    for (const file of files) {
      if (file.mimetype.startsWith('image/')) {
        const b64 = file.buffer.toString('base64');
        content.push({
          type: 'image_url',
          image_url: { url: `data:${file.mimetype};base64,${b64}` },
        });
      } else {
        const text = file.buffer.toString('utf-8');
        content.push({
          type: 'text',
          text: `📄 ไฟล์: ${file.originalname}\n\`\`\`\n${text.slice(0, 8000)}\n\`\`\``,
        });
      }
    }

    if (message) content.push({ type: 'text', text: message });

    let conversationHistory = [];
    try { conversationHistory = history ? JSON.parse(history) : []; } catch (_) {}

    const messages = [
      {
        role: 'system',
        content: 'คุณเป็น AI assistant ฉลาดและมีประโยชน์ วิเคราะห์ไฟล์และตอบคำถามได้ ตอบเป็นภาษาไทยหรืออังกฤษตามที่ผู้ใช้ถาม',
      },
      ...conversationHistory,
      { role: 'user', content },
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'AI Chat Termux',
      },
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: 4096, messages }),
    });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    const reply = data.choices?.[0]?.message?.content || '(ไม่มีคำตอบ)';
    res.json({ message: reply, model: data.model || DEFAULT_MODEL });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: DEFAULT_MODEL, hasKey: !!OPENROUTER_API_KEY });
});

app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    });
    const data = await r.json();
    const free = data.data?.filter(m => m.id.endsWith(':free')).map(m => ({ id: m.id, name: m.name })) || [];
    res.json(free);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 AI Chat รันที่ http://localhost:${PORT}`);
  console.log(`🤖 โมเดล: ${DEFAULT_MODEL}`);
  if (!OPENROUTER_API_KEY) console.warn('⚠️  ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY ใน .env');
});
