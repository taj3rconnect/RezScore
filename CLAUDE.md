# Resume Scoring - Project Context

## Business Objective
AI-powered web application that helps recruiters and hiring managers evaluate candidate resumes against specific job descriptions. The system scores each resume 0-100, extracts candidate names, and provides AI-powered resume cleaning (typo/grammar/punctuation fixes).

## Tech Stack
- **Backend**: Node.js + Express (single `server.js` file)
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework)
- **AI**: Anthropic Claude API (`claude-sonnet-4-20250514`) via `@anthropic-ai/sdk`
- **Storage**: In-memory (no database). Data is lost on server restart.

## Key Files
| File | Purpose |
|------|---------|
| `server.js` | Express server, all API endpoints, file parsing, Claude API integration |
| `public/index.html` | Landing page (job input + resume upload + results) |
| `public/js/app.js` | Landing page logic (upload, process, render results) |
| `public/resume.html` | Resume detail page (original vs cleaned side-by-side) |
| `public/js/resume.js` | Detail page logic (clean, diff highlighting, download) |
| `public/css/styles.css` | Shared responsive styles |
| `.env` | `ANTHROPIC_API_KEY` and `PORT` |

## API Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upload` | Upload resumes (multipart, max 10 files) |
| POST | `/api/process` | Score resumes against job description via Claude |
| GET | `/api/resume/:id` | Get individual resume data |
| POST | `/api/resume/:id/clean` | AI-clean a resume (cached after first call) |
| GET | `/api/resume/:id/download` | Download cleaned resume as .txt |

## Supported File Types
PDF, DOC, DOCX, TXT, HTML, RTF

## File Parsing Libraries
- `pdf-parse` - PDF text extraction
- `mammoth` - DOCX text extraction
- `word-extractor` - Legacy .doc extraction
- `cheerio` - HTML text extraction + RTF post-processing
- `@iarna/rtf-to-html` - RTF conversion

## Data Flow
1. User enters job title + description, uploads up to 10 resumes
2. Upload endpoint parses files to plain text, stores in memory, deletes files
3. Process endpoint calls Claude API to extract candidate names and score each resume
4. Results displayed sorted by score (high to low) with color-coded badges
5. Clicking a result opens detail page in new tab
6. Detail page shows original resume; CLEAN button triggers AI cleaning
7. After cleaning, original stays on left, cleaned version appears on right with word-level diff highlighting (green = added/changed, red strikethrough = removed)
8. Download button exports cleaned resume as .txt

## Running
```bash
cd C:\Projects\resume-scoring
node server.js
# Opens at http://localhost:3000
```

## Environment Variables
- `ANTHROPIC_API_KEY` - Required. Anthropic API key from console.anthropic.com
- `PORT` - Optional. Defaults to 3000

## Constraints & Limitations
- Max 10 resumes per batch
- Max 10MB per file
- In-memory storage (no persistence across restarts)
- Resume text truncated to 50,000 chars for scoring API call
- Cleaned resumes download as .txt (original formatting from PDF/DOCX is lost during extraction)
- Sequential resume processing to avoid Claude API rate limits
- Scanned/image-based PDFs will fail text extraction
