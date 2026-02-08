// Extract resume ID from URL
const params = new URLSearchParams(window.location.search);
const resumeId = params.get('id');

const candidateNameEl = document.getElementById('candidateName');
const fileNameEl = document.getElementById('fileName');
const scoreValueEl = document.getElementById('scoreValue');
const resumeTextEl = document.getElementById('resumeText');
const reasoningEl = document.getElementById('reasoning');
const cleanBtn = document.getElementById('cleanBtn');
const cleanStatus = document.getElementById('cleanStatus');
const downloadBtn = document.getElementById('downloadBtn');
const cleanedPanel = document.getElementById('cleanedPanel');
const cleanedTextEl = document.getElementById('cleanedText');

let originalText = '';

if (!resumeId) {
  candidateNameEl.textContent = 'Error: No resume ID provided';
  resumeTextEl.textContent = 'No resume ID was found in the URL.';
}

// Load resume data
async function loadResume() {
  if (!resumeId) return;

  try {
    const response = await fetch(`/api/resume/${resumeId}`);
    if (!response.ok) throw new Error('Resume not found');
    const data = await response.json();

    candidateNameEl.textContent = data.candidateName || 'Unknown Candidate';
    fileNameEl.textContent = data.originalName;
    scoreValueEl.textContent = data.score;
    resumeTextEl.textContent = data.rawText;
    reasoningEl.textContent = data.reasoning || 'No scoring data available.';
    document.title = `Resume - ${data.candidateName || 'Unknown'}`;

    originalText = data.rawText;

    if (data.cleanedText) {
      showCleanedResult(data.cleanedText);
    }
  } catch (err) {
    resumeTextEl.textContent = `Error loading resume: ${err.message}`;
  }
}

loadResume();

// Clean button
cleanBtn.addEventListener('click', async () => {
  cleanBtn.disabled = true;
  cleanBtn.innerHTML = '<span class="spinner"></span> Cleaning...';
  cleanStatus.textContent = 'AI is cleaning the resume... This may take a moment.';
  cleanStatus.className = 'status-message';

  try {
    const response = await fetch(`/api/resume/${resumeId}/clean`, {
      method: 'POST',
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Cleaning failed');
    }
    const data = await response.json();

    showCleanedResult(data.cleanedText);
    cleanStatus.textContent = 'Resume cleaned successfully!';
    cleanStatus.className = 'status-message success';
  } catch (err) {
    cleanStatus.textContent = `Error: ${err.message}`;
    cleanStatus.className = 'status-message error';
    cleanBtn.disabled = false;
    cleanBtn.innerHTML = '<span class="material-symbols-rounded">auto_fix_high</span> Clean';
  }
});

function showCleanedResult(cleanedText) {
  // Show the cleaned panel
  cleanedPanel.style.display = 'block';

  // Render the diff with highlights
  cleanedTextEl.innerHTML = buildDiffHTML(originalText, cleanedText);

  cleanBtn.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cleaned';
  cleanBtn.disabled = true;
  downloadBtn.style.display = 'inline-flex';
}

// Download button
downloadBtn.addEventListener('click', () => {
  window.location.href = `/api/resume/${resumeId}/download`;
});

// --- Word-level diff engine ---

function buildDiffHTML(oldText, newText) {
  const oldWords = tokenize(oldText);
  const newWords = tokenize(newText);
  const ops = diffWords(oldWords, newWords);

  let html = '';
  for (const op of ops) {
    const escaped = escapeHtml(op.text);
    switch (op.type) {
      case 'equal':
        html += escaped;
        break;
      case 'insert':
        html += `<span class="diff-added">${escaped}</span>`;
        break;
      case 'delete':
        html += `<span class="diff-removed">${escaped}</span>`;
        break;
    }
  }
  return html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Tokenize text into words and whitespace, preserving whitespace
function tokenize(text) {
  const tokens = [];
  const regex = /(\S+|\s+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

// Simple LCS-based diff for word arrays
function diffWords(oldTokens, newTokens) {
  const m = oldTokens.length;
  const n = newTokens.length;

  // For very large texts, use a simpler line-based approach
  if (m * n > 5000000) {
    return diffLines(oldTokens.join(''), newTokens.join(''));
  }

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get operations
  const ops = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      ops.push({ type: 'equal', text: newTokens[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', text: newTokens[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', text: oldTokens[i - 1] });
      i--;
    }
  }

  ops.reverse();

  // Merge consecutive operations of the same type
  const merged = [];
  for (const op of ops) {
    if (merged.length > 0 && merged[merged.length - 1].type === op.type) {
      merged[merged.length - 1].text += op.text;
    } else {
      merged.push({ ...op });
    }
  }

  return merged;
}

// Fallback line-based diff for very large texts
function diffLines(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = [];

  let oi = 0, ni = 0;
  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      ops.push({ type: 'equal', text: newLines[ni] + (ni < newLines.length - 1 ? '\n' : '') });
      oi++;
      ni++;
    } else {
      ops.push({ type: 'delete', text: oldLines[oi] + (oi < oldLines.length - 1 ? '\n' : '') });
      ops.push({ type: 'insert', text: newLines[ni] + (ni < newLines.length - 1 ? '\n' : '') });
      oi++;
      ni++;
    }
  }
  while (oi < oldLines.length) {
    ops.push({ type: 'delete', text: oldLines[oi] + (oi < oldLines.length - 1 ? '\n' : '') });
    oi++;
  }
  while (ni < newLines.length) {
    ops.push({ type: 'insert', text: newLines[ni] + (ni < newLines.length - 1 ? '\n' : '') });
    ni++;
  }

  return ops;
}
