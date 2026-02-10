require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;
const PDFDocument = require('pdfkit');

// Document parsers
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const cheerio = require('cheerio');
const rtfToHTML = require('@iarna/rtf-to-html');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { NodeSSH } = require('node-ssh');
const { exec, spawn } = require('child_process');
const os = require('os');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('Create a .env file with ANTHROPIC_API_KEY=your-key-here');
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// --- SQLite Database ---
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    job_title TEXT NOT NULL,
    job_description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    candidate_name TEXT,
    score INTEGER,
    reasoning TEXT,
    cleaned_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS session_resumes (
    session_id TEXT NOT NULL,
    resume_id TEXT NOT NULL,
    PRIMARY KEY (session_id, resume_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (resume_id) REFERENCES resumes(id)
  );
`);

// Migrations for P2 columns
try { db.exec('ALTER TABLE resumes ADD COLUMN sub_scores TEXT'); } catch (e) { /* column exists */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN criteria TEXT'); } catch (e) { /* column exists */ }

const stmts = {
  insertResume: db.prepare(
    'INSERT INTO resumes (id, original_name, file_type, raw_text) VALUES (?, ?, ?, ?)'
  ),
  getResume: db.prepare('SELECT * FROM resumes WHERE id = ?'),
  updateResumeScore: db.prepare(
    'UPDATE resumes SET candidate_name = ?, score = ?, reasoning = ?, sub_scores = ? WHERE id = ?'
  ),
  updateResumeClean: db.prepare(
    'UPDATE resumes SET cleaned_text = ? WHERE id = ?'
  ),
  insertSession: db.prepare(
    'INSERT INTO sessions (id, job_title, job_description, criteria) VALUES (?, ?, ?, ?)'
  ),
  insertSessionResume: db.prepare(
    'INSERT INTO session_resumes (session_id, resume_id) VALUES (?, ?)'
  ),
  getSessionResumes: db.prepare(
    'SELECT r.* FROM resumes r INNER JOIN session_resumes sr ON r.id = sr.resume_id WHERE sr.session_id = ? ORDER BY r.score DESC'
  ),
  getSessions: db.prepare(`
    SELECT s.id, s.job_title, s.created_at,
      COUNT(sr.resume_id) as resume_count,
      MAX(r.score) as top_score
    FROM sessions s
    LEFT JOIN session_resumes sr ON s.id = sr.session_id
    LEFT JOIN resumes r ON sr.resume_id = r.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
};

const insertSessionResumes = db.transaction((sessionId, resumeIds) => {
  for (const rid of resumeIds) {
    stmts.insertSessionResume.run(sessionId, rid);
  }
});

// Track locally deployed instances: { port: childProcess }
const localDeployments = {};

// --- Multer configuration ---

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.pdf', '.doc', '.docx', '.txt', '.html', '.htm', '.rtf', '.zip'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${ext}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Text extraction ---

async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  switch (ext) {
    case '.pdf': {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }
    case '.docx': {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    case '.doc': {
      const extractor = new WordExtractor();
      const doc = await extractor.extract(filePath);
      return doc.getBody();
    }
    case '.txt': {
      return fs.readFileSync(filePath, 'utf-8');
    }
    case '.html':
    case '.htm': {
      const html = fs.readFileSync(filePath, 'utf-8');
      const $ = cheerio.load(html);
      $('script, style').remove();
      return $('body').text().replace(/\s+/g, ' ').trim();
    }
    case '.rtf': {
      return new Promise((resolve, reject) => {
        const rtfContent = fs.readFileSync(filePath, 'utf-8');
        rtfToHTML.fromString(rtfContent, (err, html) => {
          if (err) return reject(err);
          const $ = cheerio.load(html);
          resolve($('body').text().replace(/\s+/g, ' ').trim());
        });
      });
    }
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

// --- Claude API functions ---

async function extractCandidateName(resumeText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: `Extract the candidate's full name from this resume. Return ONLY the name, nothing else. If you cannot determine the name, return "Unknown Candidate".\n\nResume text:\n${resumeText.substring(0, 2000)}`,
      },
    ],
  });
  return message.content[0].text.trim();
}

async function scoreResume(resumeText, jobTitle, jobDescription, criteria) {
  const hasCriteria = Array.isArray(criteria) && criteria.length > 0;

  let criteriaBlock;
  if (hasCriteria) {
    criteriaBlock = criteria.map((c, i) =>
      `${i + 1}. "${c.name}" (${c.priority}, weight: ${c.weight}%)`
    ).join('\n');
  } else {
    criteriaBlock = [
      '1. "Skills Match" (weight: 25%)',
      '2. "Experience Level" (weight: 25%)',
      '3. "Education" (weight: 25%)',
      '4. "Culture Fit" (weight: 25%)',
    ].join('\n');
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are an expert recruiter and resume evaluator. Score the following resume against the provided job description using the weighted criteria below.

Job Title: ${jobTitle}

Job Description:
${jobDescription}

Scoring Criteria:
${criteriaBlock}

Resume:
${resumeText.substring(0, 50000)}

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{
  "criteria": [
    { "name": "<criterion name>", "weight": <weight as integer>, "score": <0-100>, "reasoning": "<1-2 sentences>" }
  ],
  "total": <weighted total score 0-100>,
  "reasoning": "<2-4 sentences overall assessment>"
}

Score each criterion independently from 0 to 100. The "total" must be the weighted average of all criterion scores (sum of score*weight/100).

Score guidelines per criterion:
- 90-100: Excellent match for this criterion
- 70-89: Strong match
- 50-69: Moderate match
- 30-49: Weak match
- 0-29: Poor match`,
      },
    ],
  });

  const responseText = message.content[0].text.trim();
  try {
    const parsed = JSON.parse(responseText);
    return {
      score: parsed.total,
      reasoning: parsed.reasoning,
      subScores: { criteria: parsed.criteria, total: parsed.total },
    };
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: parsed.total || 0,
        reasoning: parsed.reasoning || 'Failed to parse AI response.',
        subScores: parsed.criteria ? { criteria: parsed.criteria, total: parsed.total } : null,
      };
    }
    return { score: 0, reasoning: 'Failed to parse AI response.', subScores: null };
  }
}

async function cleanResumeText(resumeText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a professional resume editor. Clean the following resume text by:
1. Fixing all spelling errors and typos
2. Correcting grammar and punctuation
3. Improving sentence structure where needed
4. Maintaining the original content, meaning, and formatting structure
5. Do NOT add new information or remove existing content
6. Keep section headers, dates, and factual details exactly as they are

Return ONLY the cleaned resume text, nothing else (no preamble, no explanation).

Resume text:
${resumeText}`,
      },
    ],
  });
  return message.content[0].text.trim();
}

// --- Auth middleware ---
const APP_API_KEY = process.env.APP_API_KEY;

if (APP_API_KEY) {
  console.log('API key authentication is ENABLED for /api/* routes');
} else {
  console.log('API key authentication is DISABLED (APP_API_KEY not set)');
}

// Unprotected: lets frontend know if auth is required
app.get('/api/auth-status', (req, res) => {
  res.json({ authEnabled: !!APP_API_KEY });
});

function apiKeyAuth(req, res, next) {
  if (!APP_API_KEY) return next();
  if (req.headers['x-api-key'] === APP_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
}

app.use('/api', apiKeyAuth);

// --- Rate limiting ---
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later.' },
});

app.use('/api', generalLimiter);

// --- API Endpoints ---

// Upload resumes
const RESUME_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.html', '.htm', '.rtf'];

async function processOneFile(filePath, originalName) {
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  try {
    const rawText = await extractText(filePath, originalName);
    if (!rawText || rawText.trim().length < 50) {
      return { id, originalName, success: false, error: 'Could not extract sufficient text from file (possibly scanned/image-based)' };
    }
    stmts.insertResume.run(id, originalName, path.extname(originalName).toLowerCase(), rawText);
    return { id, originalName, success: true };
  } catch (err) {
    return { id, originalName, success: false, error: err.message };
  }
}

app.post('/api/upload', upload.array('resumes', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = [];

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (ext === '.zip') {
        // Extract ZIP and process each resume inside
        try {
          const zip = new AdmZip(file.path);
          const entries = zip.getEntries();

          for (const entry of entries) {
            if (entry.isDirectory) continue;
            const entryName = entry.entryName;
            // Skip hidden files and __MACOSX
            if (entryName.startsWith('.') || entryName.startsWith('__MACOSX') || entryName.includes('/__MACOSX/') || entryName.includes('/.')) continue;

            const entryExt = path.extname(entryName).toLowerCase();
            if (!RESUME_EXTENSIONS.includes(entryExt)) continue;

            if (results.length >= 100) break;

            // Write entry to temp file for extraction
            const tmpPath = path.join(uploadsDir, `zip-${Date.now()}-${Math.random().toString(36).substr(2, 6)}${entryExt}`);
            fs.writeFileSync(tmpPath, entry.getData());
            try {
              const result = await processOneFile(tmpPath, path.basename(entryName));
              results.push(result);
            } finally {
              fs.unlink(tmpPath, () => {});
            }
          }
        } catch (zipErr) {
          results.push({ id: Date.now().toString(36), originalName: file.originalname, success: false, error: `ZIP extraction failed: ${zipErr.message}` });
        }
      } else {
        // Regular resume file
        if (results.length >= 100) break;
        const result = await processOneFile(file.path, file.originalname);
        results.push(result);
      }

      fs.unlink(file.path, () => {});
    }

    res.json({ uploaded: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate job description from title
app.post('/api/generate-jd', aiLimiter, express.json(), async (req, res) => {
  const { jobTitle } = req.body || {};
  if (!jobTitle || !jobTitle.trim()) {
    return res.status(400).json({ error: 'Job title is required' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Generate a professional, detailed job description for the role: "${jobTitle.trim()}"

Include these sections:
- About the Role (2-3 sentence summary)
- Responsibilities (6-8 bullet points)
- Requirements (5-7 bullet points covering skills, experience, education)
- Nice-to-Have (3-4 bullet points)

Write in a professional but engaging tone. Use plain text with section headers and bullet points (use "- " for bullets). Do NOT use markdown formatting like ** or ##. Return ONLY the job description text, no preamble.`,
        },
      ],
    });
    res.json({ description: message.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process resumes (score against job description) — streams results via SSE
app.post('/api/process', aiLimiter, express.json({ limit: '1mb' }), async (req, res) => {
  const { resumeIds, jobTitle, jobDescription, criteria } = req.body || {};

  if (!resumeIds || !jobTitle || !jobDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendEvent(eventType, data) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  let aborted = false;
  req.on('close', () => { aborted = true; });

  const total = resumeIds.length;
  const results = [];

  try {
    sendEvent('progress', { current: 0, total, message: `Starting to process ${total} resume(s)...` });

    for (let i = 0; i < resumeIds.length; i++) {
      if (aborted) break;
      const id = resumeIds[i];
      const resume = stmts.getResume.get(id);

      if (!resume) {
        const errorResult = { id, error: 'Resume not found' };
        results.push(errorResult);
        sendEvent('result', errorResult);
        continue;
      }

      sendEvent('progress', { current: i, total, message: `Scoring resume ${i + 1} of ${total}: ${resume.original_name}...` });

      try {
        const [candidateName, scoreResult] = await Promise.all([
          extractCandidateName(resume.raw_text),
          scoreResume(resume.raw_text, jobTitle, jobDescription, criteria),
        ]);

        stmts.updateResumeScore.run(candidateName, scoreResult.score, scoreResult.reasoning, JSON.stringify(scoreResult.subScores), id);

        const result = {
          id: resume.id,
          candidateName,
          score: scoreResult.score,
          reasoning: scoreResult.reasoning,
          subScores: scoreResult.subScores,
          originalName: resume.original_name,
        };
        results.push(result);
        sendEvent('result', result);
      } catch (err) {
        const errorResult = { id, originalName: resume.original_name, error: err.message };
        results.push(errorResult);
        sendEvent('result', errorResult);
      }

      sendEvent('progress', { current: i + 1, total, message: `Scored ${i + 1} of ${total}` });
    }

    // Create session
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    stmts.insertSession.run(sessionId, jobTitle, jobDescription, criteria ? JSON.stringify(criteria) : null);
    insertSessionResumes(sessionId, resumeIds);

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    sendEvent('complete', { results, sessionId });
  } catch (err) {
    sendEvent('error', { error: err.message });
  }

  res.end();
});

// Get resume details
app.get('/api/resume/:id', (req, res) => {
  const resume = stmts.getResume.get(req.params.id);
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }
  let subScores = null;
  try { if (resume.sub_scores) subScores = JSON.parse(resume.sub_scores); } catch (e) { /* ignore */ }

  res.json({
    id: resume.id,
    candidateName: resume.candidate_name,
    originalName: resume.original_name,
    rawText: resume.raw_text,
    score: resume.score,
    reasoning: resume.reasoning,
    subScores,
    cleanedText: resume.cleaned_text,
  });
});

// Clean resume
app.post('/api/resume/:id/clean', aiLimiter, async (req, res) => {
  try {
    const resume = stmts.getResume.get(req.params.id);
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    if (resume.cleaned_text) {
      return res.json({ cleanedText: resume.cleaned_text });
    }

    const cleanedText = await cleanResumeText(resume.raw_text);
    stmts.updateResumeClean.run(cleanedText, req.params.id);
    res.json({ cleanedText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download cleaned resume as PDF
app.get('/api/resume/:id/download', (req, res) => {
  const resume = stmts.getResume.get(req.params.id);
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }

  const textToDownload = resume.cleaned_text || resume.raw_text;
  const filename = `cleaned-${resume.original_name.replace(/\.[^/.]+$/, '')}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);

  // Header: candidate name
  if (resume.candidate_name) {
    doc.fontSize(20).font('Helvetica-Bold').text(resume.candidate_name, { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
  }

  // Resume body
  const lines = textToDownload.split('\n');
  doc.fontSize(11).font('Helvetica').fillColor('#1e293b');

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers (all caps lines or lines ending with colon)
    const isHeader = (trimmed.length > 0 && trimmed.length < 60 &&
      (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) ||
      /^[A-Z][A-Za-z\s&\/]+:$/.test(trimmed));

    if (isHeader) {
      doc.moveDown(0.3);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#2563eb').text(trimmed);
      doc.moveDown(0.2);
      doc.fontSize(11).font('Helvetica').fillColor('#1e293b');
    } else if (trimmed === '') {
      doc.moveDown(0.4);
    } else {
      doc.text(line);
    }
  }

  doc.end();
});

// --- Session History & Export ---

// List past scoring sessions
app.get('/api/sessions', (req, res) => {
  const sessions = stmts.getSessions.all();
  res.json({
    sessions: sessions.map(s => ({
      id: s.id,
      jobTitle: s.job_title,
      createdAt: s.created_at,
      resumeCount: s.resume_count,
      topScore: s.top_score,
    })),
  });
});

// Get session details with resume results
app.get('/api/sessions/:id', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const resumes = stmts.getSessionResumes.all(req.params.id);
  let sessionCriteria = null;
  try { if (session.criteria) sessionCriteria = JSON.parse(session.criteria); } catch (e) { /* ignore */ }

  res.json({
    id: session.id,
    jobTitle: session.job_title,
    jobDescription: session.job_description,
    createdAt: session.created_at,
    criteria: sessionCriteria,
    results: resumes.map(r => {
      let subScores = null;
      try { if (r.sub_scores) subScores = JSON.parse(r.sub_scores); } catch (e) { /* ignore */ }
      return {
        id: r.id,
        candidateName: r.candidate_name,
        score: r.score,
        reasoning: r.reasoning,
        subScores,
        originalName: r.original_name,
      };
    }),
  });
});

// Export session results as CSV
function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

app.get('/api/sessions/:id/export/csv', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const resumes = stmts.getSessionResumes.all(req.params.id);

  // Determine sub-score criteria names from session or first resume
  let criteriaNames = [];
  try {
    if (session.criteria) {
      criteriaNames = JSON.parse(session.criteria).map(c => c.name);
    } else {
      // Check first resume for default criteria
      for (const r of resumes) {
        if (r.sub_scores) {
          const parsed = JSON.parse(r.sub_scores);
          if (parsed.criteria) { criteriaNames = parsed.criteria.map(c => c.name); break; }
        }
      }
    }
  } catch (e) { /* ignore */ }

  const headers = ['Candidate Name', 'Filename', 'Score'];
  for (const name of criteriaNames) headers.push(name);
  headers.push('Reasoning');
  const csvRows = [headers.join(',')];

  for (const r of resumes) {
    let subScores = null;
    try { if (r.sub_scores) subScores = JSON.parse(r.sub_scores); } catch (e) { /* ignore */ }

    const row = [
      csvEscape(r.candidate_name || 'Unknown'),
      csvEscape(r.original_name),
      r.score !== null ? r.score : '',
    ];
    for (const name of criteriaNames) {
      const criterion = subScores?.criteria?.find(c => c.name === name);
      row.push(criterion ? criterion.score : '');
    }
    row.push(csvEscape(r.reasoning || ''));
    csvRows.push(row.join(','));
  }

  const filename = `scores-${session.job_title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvRows.join('\r\n'));
});

// Compare candidates
app.post('/api/compare', express.json(), (req, res) => {
  const { resumeIds } = req.body || {};
  if (!Array.isArray(resumeIds) || resumeIds.length < 2 || resumeIds.length > 3) {
    return res.status(400).json({ error: 'Provide 2 or 3 resume IDs to compare' });
  }

  const candidates = resumeIds.map(id => {
    const r = stmts.getResume.get(id);
    if (!r) return null;
    let subScores = null;
    try { if (r.sub_scores) subScores = JSON.parse(r.sub_scores); } catch (e) { /* ignore */ }
    return {
      id: r.id,
      candidateName: r.candidate_name,
      originalName: r.original_name,
      score: r.score,
      reasoning: r.reasoning,
      subScores,
    };
  }).filter(Boolean);

  if (candidates.length < 2) {
    return res.status(404).json({ error: 'One or more resumes not found' });
  }

  res.json({ candidates });
});

// --- Deploy helpers ---

function getProjectFiles(baseDir) {
  const entries = [];
  const ignored = ['node_modules', 'uploads', '.git', '.env', '.claude'];

  function walk(dir, relative) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (ignored.includes(item.name)) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = path.join(relative, item.name);
      if (item.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        entries.push({ fullPath, relPath });
      }
    }
  }

  walk(baseDir, '');
  return entries;
}

// Get the directory containing the current node executable so npm is also found
const nodeDir = path.dirname(process.execPath);
const deployEnvPath = nodeDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '');

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 120000, env: { ...process.env, PATH: deployEnvPath } }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

// Deploy endpoint
app.post('/api/deploy', express.json({ limit: '1mb' }), async (req, res) => {
  const { target } = req.body;
  const steps = [];

  try {
    if (target === 'local') {
      // --- LOCAL DEPLOYMENT ---
      const { port } = req.body;
      if (!port || port < 1024 || port > 65535) {
        return res.status(400).json({ error: 'Invalid port (1024-65535)' });
      }

      // Kill previous deployment on this port if any
      if (localDeployments[port]) {
        try { localDeployments[port].kill(); } catch (e) { /* ignore */ }
        delete localDeployments[port];
      }

      steps.push({ message: 'Creating deployment directory...', status: 'info' });

      const tmpDir = path.join(os.tmpdir(), `resume-scoring-deploy-${port}`);
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tmpDir, { recursive: true });

      // Copy project files
      steps.push({ message: 'Copying project files...', status: 'info' });
      const files = getProjectFiles(__dirname);
      for (const file of files) {
        const destPath = path.join(tmpDir, file.relPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(file.fullPath, destPath);
      }

      // Copy .env with overridden PORT
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(/^PORT=.*/m, `PORT=${port}`);
        if (!/^PORT=/m.test(envContent)) {
          envContent += `\nPORT=${port}`;
        }
        fs.writeFileSync(path.join(tmpDir, '.env'), envContent);
      }

      // Install dependencies
      steps.push({ message: 'Installing dependencies (npm install)...', status: 'info' });
      await runCommand('npm install --production', tmpDir);
      steps.push({ message: 'Dependencies installed.', status: 'success' });

      // Start server process
      steps.push({ message: `Starting server on port ${port}...`, status: 'info' });

      // Find node executable path
      const nodePath = process.execPath;
      const child = spawn(nodePath, ['server.js'], {
        cwd: tmpDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PORT: String(port) },
      });
      child.unref();
      localDeployments[port] = child;

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 2500));

      steps.push({ message: `Server started on port ${port}.`, status: 'success' });

      const url = `http://localhost:${port}`;
      res.json({ success: true, url, steps });

    } else if (target === 'external' || target === 'cloud') {
      // --- REMOTE DEPLOYMENT (SSH) ---
      const { host, sshPort, username, password, privateKey, remotePath, appPort } = req.body;

      if (!host || !username || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: host, username, remotePath' });
      }
      if (!password && !privateKey) {
        return res.status(400).json({ error: 'Password or SSH private key is required' });
      }

      const ssh = new NodeSSH();

      steps.push({ message: `Connecting to ${host}:${sshPort || 22}...`, status: 'info' });

      const connectConfig = {
        host,
        port: sshPort || 22,
        username,
        tryKeyboard: true,
      };
      if (privateKey) {
        connectConfig.privateKey = privateKey;
      } else {
        connectConfig.password = password;
      }

      await ssh.connect(connectConfig);
      steps.push({ message: 'SSH connection established.', status: 'success' });

      // Create remote directory
      steps.push({ message: `Creating remote directory: ${remotePath}...`, status: 'info' });
      await ssh.execCommand(`mkdir -p ${remotePath}`);

      // Upload project files
      steps.push({ message: 'Uploading project files via SFTP...', status: 'info' });
      const files = getProjectFiles(__dirname);

      // Create remote subdirectories
      const remoteDirs = new Set();
      for (const file of files) {
        const remoteDir = path.posix.join(remotePath, path.dirname(file.relPath).replace(/\\/g, '/'));
        if (remoteDir !== remotePath) remoteDirs.add(remoteDir);
      }
      for (const dir of remoteDirs) {
        await ssh.execCommand(`mkdir -p ${dir}`);
      }

      // Upload files
      for (const file of files) {
        const remoteFilePath = path.posix.join(remotePath, file.relPath.replace(/\\/g, '/'));
        await ssh.putFile(file.fullPath, remoteFilePath);
      }
      steps.push({ message: `${files.length} files uploaded.`, status: 'success' });

      // Upload .env with target port
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(/^PORT=.*/m, `PORT=${appPort || 3000}`);
        if (!/^PORT=/m.test(envContent)) {
          envContent += `\nPORT=${appPort || 3000}`;
        }
        const tmpEnv = path.join(os.tmpdir(), `.env-deploy-${Date.now()}`);
        fs.writeFileSync(tmpEnv, envContent);
        await ssh.putFile(tmpEnv, path.posix.join(remotePath, '.env'));
        fs.unlinkSync(tmpEnv);
      }

      // Install dependencies on remote
      steps.push({ message: 'Running npm install on remote server...', status: 'info' });
      const installResult = await ssh.execCommand('npm install --production', { cwd: remotePath });
      if (installResult.code !== 0 && installResult.stderr) {
        steps.push({ message: `npm install warning: ${installResult.stderr.substring(0, 200)}`, status: 'info' });
      }
      steps.push({ message: 'Dependencies installed on remote.', status: 'success' });

      // Stop any existing process on the target port
      steps.push({ message: 'Stopping any existing process on target port...', status: 'info' });
      await ssh.execCommand(`lsof -ti:${appPort || 3000} | xargs kill -9 2>/dev/null || true`);

      // Start server on remote
      steps.push({ message: `Starting server on remote port ${appPort || 3000}...`, status: 'info' });
      await ssh.execCommand(
        `cd ${remotePath} && nohup node server.js > /dev/null 2>&1 &`,
        { cwd: remotePath }
      );

      steps.push({ message: 'Remote server started.', status: 'success' });

      ssh.dispose();

      const url = `http://${host}:${appPort || 3000}`;
      res.json({ success: true, url, steps });

    } else {
      return res.status(400).json({ error: 'Invalid deployment target. Use: local, external, or cloud.' });
    }
  } catch (err) {
    steps.push({ message: `Error: ${err.message}`, status: 'error' });
    res.status(500).json({ error: err.message, steps });
  }
});

// Clean up on exit
process.on('exit', () => {
  Object.values(localDeployments).forEach((child) => {
    try { child.kill(); } catch (e) { /* ignore */ }
  });
  try { db.close(); } catch (e) { /* ignore */ }
});

process.on('SIGINT', () => {
  Object.values(localDeployments).forEach((child) => {
    try { child.kill(); } catch (e) { /* ignore */ }
  });
  try { db.close(); } catch (e) { /* ignore */ }
  process.exit();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Error handling for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Maximum 100 files allowed' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Resume Scoring app running at http://localhost:${PORT}`);
});
