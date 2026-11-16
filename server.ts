import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'start';
const port = Number(process.env.PORT) || 3000;

const DEV_PASSWORD = '@#$&ali@#';
const DEV_PRIV_JWK = {
  kty: 'EC',
  x: 'JTO7mDyHxnKWtpXK9cl_2ds6VkK9rTivOF2CVKHUhoI',
  y: 'BIr6_Jk-y7Zbt1bGeQWLJmZ2T9RMVrhcbUl7U0f1iJ0',
  crv: 'P-256',
  d: '7N-ayR3SD70dwNNNTYkI9dk5Mc2Uh2gfIpkaF2N9Bkg',
} as const;

const signingKey = crypto.createPrivateKey({ key: DEV_PRIV_JWK, format: 'jwk' });

interface ExportRecord {
  used: number;
  quota: number;
  hashes: Set<string>;
}

interface GeneratedCodeRecord {
  id: string;
  plan: string;
  exp: string;
  papers: number;
  code: string;
  mode: 'auto' | 'manual';
  createdAt: string;
}

const exportStore = new Map<string, ExportRecord>();
const generatedCodes: GeneratedCodeRecord[] = [];
const pushSubscriptions = new Set<string>();

function b64u(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signLicensePayload(payload: { id: string; exp: string; papers: number; plan: string }): string {
  const payloadB64 = b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(payloadB64, 'utf8'), {
    key: signingKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${payloadB64}.${b64u(sig)}`;
}

function addDaysIso(days: number): string {
  const d = new Date(Date.now() + Math.max(1, days) * 86400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/notice', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, n: 0 });
  });

  app.post('/api/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code) {
      res.status(400).json({ ok: false, err: 'missing_code' });
      return;
    }
    const rec = exportStore.get(code);
    if (!rec) {
      res.json({ ok: false });
      return;
    }
    res.json({
      ok: true,
      used: rec.used,
      quota: rec.quota,
      active: rec.used < rec.quota,
    });
  });

  app.post('/api/export', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const hash = typeof req.body?.h === 'string' ? req.body.h : '';
    if (!code) {
      res.status(400).json({ ok: false, err: 'missing_code' });
      return;
    }
    let rec = exportStore.get(code);
    if (!rec) {
      rec = { used: 0, quota: 100, hashes: new Set<string>() };
      exportStore.set(code, rec);
    }
    let counted = false;
    if (hash && !rec.hashes.has(hash)) {
      rec.hashes.add(hash);
      rec.used += 1;
      counted = true;
    }
    res.json({
      ok: true,
      used: rec.used,
      quota: rec.quota,
      active: rec.used < rec.quota,
      counted,
    });
  });

  app.post('/api/consent', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/report', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/push', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (endpoint) {
      pushSubscriptions.add(endpoint);
    }
    res.json({ ok: true });
  });

  app.post('/api/dev/verify', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== DEV_PASSWORD) {
      res.status(401).json({ ok: false, err: 'invalid_password' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/dev/generate', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== DEV_PASSWORD) {
      res.status(401).json({ ok: false, err: 'invalid_password' });
      return;
    }

    const mode: 'auto' | 'manual' = req.body?.mode === 'manual' ? 'manual' : 'auto';
    const planRaw = typeof req.body?.plan === 'string' ? req.body.plan.trim() : 'سنوي';
    const validPlans = new Set(['أسبوعان', 'شهري', 'فصلي', 'سنوي']);
    const plan = validPlans.has(planRaw) ? planRaw : 'سنوي';

    const defaultDays: Record<string, number> = {
      'أسبوعان': 14,
      'شهري': 30,
      'فصلي': 120,
      'سنوي': 365,
    };
    const defaultPapers: Record<string, number> = {
      'أسبوعان': 15,
      'شهري': 40,
      'فصلي': 120,
      'سنوي': 250,
    };

    const daysNum = Number.isFinite(Number(req.body?.days)) && Number(req.body.days) > 0
      ? Math.min(3650, Math.round(Number(req.body.days)))
      : defaultDays[plan];

    const papersNum = Number.isFinite(Number(req.body?.papers)) && Number(req.body.papers) > 0
      ? Math.min(100000, Math.round(Number(req.body.papers)))
      : defaultPapers[plan];

    let exp = '';
    if (mode === 'manual' && typeof req.body?.exp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.exp.trim())) {
      exp = req.body.exp.trim();
    } else {
      exp = addDaysIso(daysNum);
    }

    let id = '';
    if (mode === 'manual' && typeof req.body?.codeId === 'string' && req.body.codeId.trim()) {
      id = req.body.codeId.trim().slice(0, 48);
    } else {
      const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
      id = `BRH-${rand.slice(0, 4)}-${rand.slice(4, 8)}`;
    }

    const payload = { id, exp, papers: papersNum, plan };
    const code = signLicensePayload(payload);

    exportStore.set(code, {
      used: 0,
      quota: papersNum,
      hashes: new Set<string>(),
    });

    const record: GeneratedCodeRecord = {
      id,
      plan,
      exp,
      papers: papersNum,
      code,
      mode,
      createdAt: new Date().toISOString(),
    };
    generatedCodes.unshift(record);
    if (generatedCodes.length > 50) generatedCodes.pop();

    res.json({ ok: true, code, payload, history: generatedCodes.slice(0, 15) });
  });

  app.post('/api/dev/list', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== DEV_PASSWORD) {
      res.status(401).json({ ok: false, err: 'invalid_password' });
      return;
    }
    res.json({ ok: true, history: generatedCodes.slice(0, 15) });
  });

  app.post('/api/solve', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        err: 'missing_key',
        msg: 'خدمة الحل التلقائي غير مفعلة حالياً على الخادم.',
      });
      return;
    }

    const rawQuestions = Array.isArray(req.body?.questions) ? req.body.questions : [];
    const formattedQuestions: string[] = [];

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i] || {};
      const qNum = i + 1;
      const lines: string[] = [];
      const topic = typeof q.topic === 'string' ? q.topic.trim() : '';
      const body = typeof q.body === 'string' ? q.body.trim() : '';
      const grade = typeof q.grade === 'string' ? q.grade.trim() : '';
      const header = [`Q${qNum}${grade ? ` (${grade})` : ''}`];
      if (topic) header.push(topic);
      lines.push(header.join(' - '));
      if (body) lines.push(body);

      const parts = Array.isArray(q.parts) ? q.parts : [];
      parts.forEach((p: Record<string, unknown>, pi: number) => {
        const kind = typeof p.kind === 'string' ? p.kind : 'text';
        const pText = typeof p.text === 'string' ? p.text.trim() : '';
        const pGrade = typeof p.grade === 'string' ? p.grade.trim() : '';
        const label = `  Part ${pi + 1} [${kind}]${pGrade ? ` (${pGrade})` : ''}:`;
        if (pText) {
          lines.push(`${label} ${pText}`);
        } else {
          lines.push(label);
        }
        if (kind === 'mcq' && Array.isArray(p.opts)) {
          p.opts.forEach((opt: unknown, oi: number) => {
            const oText = typeof opt === 'string' ? opt.trim() : '';
            if (oText) lines.push(`    - Option ${oi + 1}: ${oText}`);
          });
        } else if ((kind === 'tf' || kind === 'blank') && Array.isArray(p.items)) {
          p.items.forEach((it: unknown, ii: number) => {
            const itText = it && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string'
              ? ((it as { text: string }).text).trim()
              : '';
            if (itText) lines.push(`    ${ii + 1}) ${itText}`);
          });
        } else if (kind === 'match' && Array.isArray(p.pairs)) {
          const colA: string[] = [];
          const colB: string[] = [];
          p.pairs.forEach((pr: unknown, pri: number) => {
            if (pr && typeof pr === 'object') {
              const a = typeof (pr as { a?: unknown }).a === 'string' ? (pr as { a: string }).a.trim() : '';
              const b = typeof (pr as { b?: unknown }).b === 'string' ? (pr as { b: string }).b.trim() : '';
              if (a) colA.push(`${pri + 1}. ${a}`);
              if (b) colB.push(`${b}`);
            }
          });
          if (Array.isArray(p.extra)) {
            p.extra.forEach((ex: unknown) => {
              const exs = typeof ex === 'string' ? ex.trim() : '';
              if (exs) colB.push(exs);
            });
          }
          if (colA.length) lines.push(`    Column 1: ${colA.join(' | ')}`);
          if (colB.length) lines.push(`    Column 2: ${colB.join(' | ')}`);
        }
      });

      const joined = lines.join('\n').trim();
      const hasContent = Boolean(
        topic ||
        body ||
        parts.some((p: Record<string, unknown>) =>
          (typeof p.text === 'string' && p.text.trim()) ||
          (Array.isArray(p.opts) && p.opts.some((o: unknown) => typeof o === 'string' && o.trim())) ||
          (Array.isArray(p.items) && p.items.some((it: unknown) => it && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string' && (it as { text: string }).text.trim())) ||
          (Array.isArray(p.pairs) && p.pairs.some((pr: unknown) => pr && typeof pr === 'object' && ((typeof (pr as { a?: unknown }).a === 'string' && (pr as { a: string }).a.trim()) || (typeof (pr as { b?: unknown }).b === 'string' && (pr as { b: string }).b.trim()))))
        )
      );
      if (hasContent) {
        formattedQuestions.push(joined);
      }
    }

    if (formattedQuestions.length === 0) {
      res.status(400).json({ ok: false, err: 'empty_questions' });
      return;
    }

    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const grade = typeof req.body?.grade === 'string' ? req.body.grade.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const paperLang = req.body?.paperLang === 'en' ? 'en' : 'ar';
    const uiLang = req.body?.uiLang === 'en' ? 'en' : 'ar';

    const prompt = [
      'You are an expert teacher creating a clear, accurate model answer key (الأجوبة النموذجية) for an exam.',
      `Exam Info: Title="${title || 'Exam'}", Subject="${subject || 'General'}", Grade="${grade || 'General'}", Paper Language="${paperLang}", UI Language="${uiLang}".`,
      'Instructions:',
      '- Answer in the exact language of each question (if a question is in Arabic, write the answer in clear Arabic; if in English, write in clear English).',
      '- For multiple-choice (mcq), state the exact correct option clearly.',
      '- For true/false (tf), state True/False (صح/خطأ) for each item with a brief correction if false.',
      '- For fill-in-the-blank (blank), list each blank answer clearly in order.',
      '- For matching (match), list each item from Column 1 paired with its matching answer from Column 2.',
      '- For essay/math/science questions (text), give the final answer cleanly and include concise solution steps when helpful.',
      '',
      'Questions:',
      formattedQuestions.join('\n\n'),
    ].join('\n');

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Brief header/summary line for the answer key.',
              },
              solutions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    qNum: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                    answer: { type: Type.STRING },
                    steps: { type: Type.STRING },
                  },
                  required: ['qNum', 'title', 'answer'],
                },
              },
            },
            required: ['solutions'],
          },
        },
      });

      const rawText = (response.text || '').trim();
      const parsed = JSON.parse(rawText || '{}') as {
        summary?: string;
        solutions?: Array<{ qNum?: number; title?: string; answer?: string; steps?: string }>;
      };

      const solutions = Array.isArray(parsed.solutions) ? parsed.solutions : [];
      res.json({
        ok: true,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        solutions,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Auto-solve error:', msg);
      res.status(502).json({
        ok: false,
        err: 'solve_failed',
        msg,
      });
    }
  });

  app.post('/api/transcribe', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        ok: false,
        err: 'missing_key',
        msg: 'خدمة تحويل الصوت غير مفعلة حالياً.',
      });
      return;
    }

    const audio = typeof req.body?.audio === 'string' ? req.body.audio.trim() : '';
    const mimeTypeRaw = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim() : 'audio/webm';
    const mimeType = mimeTypeRaw.split(';')[0] || 'audio/webm';
    const lang = req.body?.lang === 'en' ? 'en' : 'ar';

    if (!audio) {
      res.status(400).json({ ok: false, err: 'missing_audio' });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      const promptText = lang === 'en'
        ? 'Transcribe this spoken exam question accurately verbatim in English with proper punctuation. Output ONLY the transcribed text, with no extra commentary or quotes.'
        : 'انسخ هذا الكلام المنطوق إلى نص عربي واضح ودقيق مع علامات الترقيم المناسبة لأسئلة الامتحانات. أعد النص المنسوخ فقط بدون أي مقدمات أو تعليقات.';

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            { inlineData: { mimeType, data: audio } },
            { text: promptText },
          ],
        },
      });

      const text = (response.text || '').trim();
      res.json({ ok: true, text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Transcribe error:', msg);
      res.status(502).json({ ok: false, err: 'transcribe_failed', msg });
    }
  });

  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js' || req.path === '/manifest.json' || req.path === '/manifest-mi.json') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });

  const distDir = path.resolve(__dirname, 'dist');
  const publicDir = path.resolve(__dirname, 'public');
  const distIndex = path.join(distDir, 'index.html');
  const rootIndex = path.resolve(__dirname, 'index.html');

  const mountStaticFallback = () => {
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
    }
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir));
    }
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ ok: false, err: 'not_found' });
        return;
      }
      const entry = fs.existsSync(distIndex) ? distIndex : rootIndex;
      res.sendFile(entry);
    });
  };

  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (err) {
      if (fs.existsSync(distIndex) || fs.existsSync(rootIndex)) {
        mountStaticFallback();
      } else {
        throw err;
      }
    }
  } else {
    mountStaticFallback();
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Barham server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
