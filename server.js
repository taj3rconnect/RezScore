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

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// In-memory store for processed resumes
const resumeStore = {};

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
  const allowedTypes = ['.pdf', '.doc', '.docx', '.txt', '.html', '.htm', '.rtf'];
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

async function scoreResume(resumeText, jobTitle, jobDescription) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are an expert recruiter and resume evaluator. Score the following resume against the provided job description.

Job Title: ${jobTitle}

Job Description:
${jobDescription}

Resume:
${resumeText.substring(0, 50000)}

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{
  "score": <number 0-100>,
  "reasoning": "<2-4 sentences explaining the score>"
}

Score criteria:
- 90-100: Excellent match, meets nearly all requirements
- 70-89: Strong match, meets most key requirements
- 50-69: Moderate match, meets some requirements
- 30-49: Weak match, meets few requirements
- 0-29: Poor match, does not align with the role`,
      },
    ],
  });

  const responseText = message.content[0].text.trim();
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { score: 0, reasoning: 'Failed to parse AI response.' };
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

// --- API Endpoints ---

// Upload resumes
app.post('/api/upload', upload.array('resumes', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = [];
    for (const file of req.files) {
      const id =
        Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
      try {
        const rawText = await extractText(file.path, file.originalname);

        if (!rawText || rawText.trim().length < 50) {
          results.push({
            id,
            originalName: file.originalname,
            success: false,
            error: 'Could not extract sufficient text from file (possibly scanned/image-based)',
          });
          continue;
        }

        resumeStore[id] = {
          id,
          originalName: file.originalname,
          fileType: path.extname(file.originalname).toLowerCase(),
          rawText,
          candidateName: null,
          score: null,
          reasoning: null,
          cleanedText: null,
        };
        results.push({ id, originalName: file.originalname, success: true });
      } catch (err) {
        results.push({
          id,
          originalName: file.originalname,
          success: false,
          error: err.message,
        });
      } finally {
        fs.unlink(file.path, () => {});
      }
    }

    res.json({ uploaded: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process resumes (score against job description)
app.post('/api/process', express.json(), async (req, res) => {
  try {
    const { resumeIds, jobTitle, jobDescription } = req.body;

    if (!resumeIds || !jobTitle || !jobDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const results = [];

    for (const id of resumeIds) {
      const resume = resumeStore[id];
      if (!resume) {
        results.push({ id, error: 'Resume not found' });
        continue;
      }

      try {
        const [candidateName, scoreResult] = await Promise.all([
          extractCandidateName(resume.rawText),
          scoreResume(resume.rawText, jobTitle, jobDescription),
        ]);

        resume.candidateName = candidateName;
        resume.score = scoreResult.score;
        resume.reasoning = scoreResult.reasoning;

        results.push({
          id: resume.id,
          candidateName: resume.candidateName,
          score: resume.score,
          reasoning: resume.reasoning,
          originalName: resume.originalName,
        });
      } catch (err) {
        results.push({ id, originalName: resume.originalName, error: err.message });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get resume details
app.get('/api/resume/:id', (req, res) => {
  const resume = resumeStore[req.params.id];
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }
  res.json({
    id: resume.id,
    candidateName: resume.candidateName,
    originalName: resume.originalName,
    rawText: resume.rawText,
    score: resume.score,
    reasoning: resume.reasoning,
    cleanedText: resume.cleanedText,
  });
});

// Clean resume
app.post('/api/resume/:id/clean', async (req, res) => {
  try {
    const resume = resumeStore[req.params.id];
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    if (resume.cleanedText) {
      return res.json({ cleanedText: resume.cleanedText });
    }

    const cleanedText = await cleanResumeText(resume.rawText);
    resume.cleanedText = cleanedText;
    res.json({ cleanedText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download cleaned resume as PDF
app.get('/api/resume/:id/download', (req, res) => {
  const resume = resumeStore[req.params.id];
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }

  const textToDownload = resume.cleanedText || resume.rawText;
  const filename = `cleaned-${resume.originalName.replace(/\.[^/.]+$/, '')}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);

  // Header: candidate name
  if (resume.candidateName) {
    doc.fontSize(20).font('Helvetica-Bold').text(resume.candidateName, { align: 'center' });
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Error handling for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Maximum 10 files allowed' });
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
