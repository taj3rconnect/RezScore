// --- State ---
let selectedFiles = [];
let uploadedResumeIds = [];
let currentSessionId = null;
let compareSelection = new Set();

// --- DOM references ---
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const fileListEl = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const processBtn = document.getElementById('processBtn');
const processStatus = document.getElementById('processStatus');
const resultsSection = document.getElementById('resultsSection');
const resultsContainer = document.getElementById('resultsContainer');

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = 'status-message' + (type ? ' ' + type : '');
}

// --- Browse ---
browseBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length > 100) {
    alert('Maximum 100 files allowed. Please select fewer files.');
    fileInput.value = '';
    return;
  }
  selectedFiles = files;
  renderFileList();
  uploadBtn.disabled = false;
  setStatus(uploadStatus, '');
});

function renderFileList() {
  if (selectedFiles.length === 0) {
    fileListEl.innerHTML = '';
    return;
  }

  fileListEl.innerHTML = selectedFiles
    .map(
      (file, i) => `
    <div class="file-item">
      <span class="material-symbols-rounded file-icon">description</span>
      <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="file-size">${formatFileSize(file.size)}</span>
      <button class="remove-btn" onclick="removeFile(${i})" title="Remove">
        <span class="material-symbols-rounded" style="font-size:18px;">close</span>
      </button>
    </div>
  `
    )
    .join('');
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileList();
  if (selectedFiles.length === 0) {
    uploadBtn.disabled = true;
    fileInput.value = '';
  }
}

// --- Upload ---
uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  uploadBtn.disabled = true;
  uploadBtn.innerHTML = '<span class="spinner"></span> Uploading...';
  setStatus(uploadStatus, 'Uploading and parsing files...');

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('resumes', file));

  try {
    const response = await authFetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error);

    uploadedResumeIds = data.uploaded.filter((r) => r.success).map((r) => r.id);

    const failures = data.uploaded.filter((r) => !r.success);
    let statusMsg = `${uploadedResumeIds.length} file(s) uploaded successfully.`;
    if (failures.length > 0) {
      statusMsg += ` ${failures.length} failed: ${failures.map((f) => f.originalName).join(', ')}`;
    }

    setStatus(uploadStatus, statusMsg, 'success');
    processBtn.disabled = uploadedResumeIds.length === 0;
  } catch (err) {
    setStatus(uploadStatus, `Upload failed: ${err.message}`, 'error');
  } finally {
    uploadBtn.innerHTML = '<span class="material-symbols-rounded">cloud_upload</span> Upload';
    uploadBtn.disabled = false;
  }
});

// --- Generate JD with AI ---
const generateJdBtn = document.getElementById('generateJdBtn');
const jobTitleInput = document.getElementById('jobTitle');
const jobDescriptionInput = document.getElementById('jobDescription');

jobTitleInput.addEventListener('input', () => {
  generateJdBtn.disabled = !jobTitleInput.value.trim();
});

generateJdBtn.addEventListener('click', async () => {
  const title = jobTitleInput.value.trim();
  if (!title) return;

  if (jobDescriptionInput.value.trim() && !confirm('This will replace the current job description. Continue?')) {
    return;
  }

  generateJdBtn.disabled = true;
  generateJdBtn.innerHTML = '<span class="spinner spinner-dark" style="width:14px;height:14px;border-width:2px;"></span> Generating...';

  try {
    const response = await authFetch('/api/generate-jd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobTitle: title }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Generation failed');
    jobDescriptionInput.value = data.description;
  } catch (err) {
    alert('Failed to generate job description: ' + err.message);
  } finally {
    generateJdBtn.disabled = false;
    generateJdBtn.innerHTML = '<span class="material-symbols-rounded">auto_awesome</span> Generate with AI';
  }
});

// --- Scoring Criteria ---
const toggleCriteria = document.getElementById('toggleCriteria');
const criteriaBody = document.getElementById('criteriaBody');
const criteriaList = document.getElementById('criteriaList');
const addCriterionBtn = document.getElementById('addCriterionBtn');
const criteriaWeightInfo = document.getElementById('criteriaWeightInfo');

toggleCriteria.addEventListener('click', () => {
  const open = criteriaBody.style.display !== 'none';
  criteriaBody.style.display = open ? 'none' : 'block';
  toggleCriteria.querySelector('.criteria-toggle-icon').textContent = open ? 'expand_more' : 'expand_less';
});

addCriterionBtn.addEventListener('click', () => addCriterionRow());

function addCriterionRow(name = '', priority = 'must-have', weight = '') {
  const row = document.createElement('div');
  row.className = 'criterion-row';
  row.innerHTML = `
    <input type="text" class="criterion-name" placeholder="Criterion name" value="${escapeHtml(name)}">
    <select class="criterion-priority">
      <option value="must-have"${priority === 'must-have' ? ' selected' : ''}>Must-have</option>
      <option value="nice-to-have"${priority === 'nice-to-have' ? ' selected' : ''}>Nice-to-have</option>
    </select>
    <input type="number" class="criterion-weight" placeholder="%" min="1" max="100" value="${weight}">
    <button type="button" class="criterion-remove" title="Remove">
      <span class="material-symbols-rounded" style="font-size:18px;">close</span>
    </button>
  `;
  row.querySelector('.criterion-remove').addEventListener('click', () => {
    row.remove();
    updateWeightInfo();
  });
  row.querySelector('.criterion-weight').addEventListener('input', updateWeightInfo);
  criteriaList.appendChild(row);
  updateWeightInfo();
}

function updateWeightInfo() {
  const weights = Array.from(criteriaList.querySelectorAll('.criterion-weight'))
    .map(el => parseFloat(el.value) || 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) {
    criteriaWeightInfo.textContent = '';
  } else if (total === 0) {
    criteriaWeightInfo.textContent = 'Enter weights for each criterion (will be normalized to 100%)';
  } else {
    criteriaWeightInfo.textContent = `Total weight: ${total}%${total !== 100 ? ' (will be normalized to 100%)' : ''}`;
  }
}

function collectCriteria() {
  const rows = criteriaList.querySelectorAll('.criterion-row');
  if (rows.length === 0) return null;

  const criteria = [];
  let totalWeight = 0;
  for (const row of rows) {
    const name = row.querySelector('.criterion-name').value.trim();
    const priority = row.querySelector('.criterion-priority').value;
    const weight = parseFloat(row.querySelector('.criterion-weight').value) || 0;
    if (!name) continue;
    criteria.push({ name, priority, weight });
    totalWeight += weight;
  }

  if (criteria.length === 0) return null;

  // Normalize weights to 100%
  if (totalWeight > 0) {
    for (const c of criteria) {
      c.weight = Math.round((c.weight / totalWeight) * 100);
    }
    // Fix rounding to exactly 100
    const diff = 100 - criteria.reduce((a, c) => a + c.weight, 0);
    if (diff !== 0) criteria[0].weight += diff;
  } else {
    const even = Math.floor(100 / criteria.length);
    criteria.forEach((c, i) => { c.weight = i === 0 ? 100 - even * (criteria.length - 1) : even; });
  }

  return criteria;
}

// --- Process (SSE streaming) ---
processBtn.addEventListener('click', async () => {
  const jobTitle = document.getElementById('jobTitle').value.trim();
  const jobDescription = document.getElementById('jobDescription').value.trim();

  if (!jobTitle) { alert('Please enter a job title.'); return; }
  if (!jobDescription) { alert('Please enter a job description.'); return; }
  if (uploadedResumeIds.length === 0) { alert('Please upload resumes first.'); return; }

  processBtn.disabled = true;
  processBtn.innerHTML = '<span class="spinner"></span> Processing...';
  setStatus(processStatus, `Starting AI analysis of ${uploadedResumeIds.length} resume(s)...`);

  // Show results section and clear previous results
  resultsSection.style.display = 'block';
  resultsContainer.innerHTML = '';
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  exportCsvBtn.style.display = 'none';

  try {
    const criteria = collectCriteria();
    const response = await authFetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeIds: uploadedResumeIds, jobTitle, jobDescription, criteria }),
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Processing failed');
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      let eventType = null;
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.substring(7).trim();
        } else if (line.startsWith('data: ')) {
          dataStr = line.substring(6);
        } else if (line === '' && eventType && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            handleSSEEvent(data, eventType);
          } catch (e) { /* ignore parse errors */ }
          eventType = null;
          dataStr = '';
        }
      }
    }

    setStatus(processStatus, 'Processing complete!', 'success');
  } catch (err) {
    setStatus(processStatus, `Processing failed: ${err.message}`, 'error');
  } finally {
    processBtn.innerHTML = '<span class="material-symbols-rounded">auto_awesome</span> Process with AI';
    processBtn.disabled = false;
  }
});

function handleSSEEvent(data, eventType) {
  switch (eventType) {
    case 'progress':
      setStatus(processStatus, data.message);
      break;
    case 'result':
      appendResultCard(data);
      break;
    case 'complete':
      currentSessionId = data.sessionId;
      renderResults(data.results, data.sessionId);
      loadHistory();
      break;
    case 'error':
      setStatus(processStatus, `Error: ${data.error}`, 'error');
      break;
  }
}

function renderSubScoreBars(subScores) {
  if (!subScores || !subScores.criteria) return '';
  return `<div class="sub-scores">${subScores.criteria.map(c => {
    const cls = c.score >= 70 ? 'bar-high' : c.score >= 50 ? 'bar-mid' : 'bar-low';
    return `<div class="sub-score-row">
      <span class="sub-score-name">${escapeHtml(c.name)}</span>
      <div class="sub-score-track"><div class="sub-score-fill ${cls}" style="width:${c.score}%"></div></div>
      <span class="sub-score-val">${c.score}</span>
    </div>`;
  }).join('')}</div>`;
}

function appendResultCard(r) {
  if (r.error) {
    resultsContainer.insertAdjacentHTML('beforeend', `<div class="result-card result-error">
      <div class="score-badge score-low">
        <span class="material-symbols-rounded" style="font-size:24px;">error</span>
      </div>
      <div class="candidate-info">
        <span class="candidate-name">${escapeHtml(r.originalName || 'Unknown')}</span>
        <p class="reasoning" style="color:var(--md-error)">${escapeHtml(r.error)}</p>
      </div>
    </div>`);
    return;
  }

  const scoreClass = r.score >= 70 ? 'score-high' : r.score >= 50 ? 'score-mid' : 'score-low';
  resultsContainer.insertAdjacentHTML('beforeend', `<div class="result-card" data-id="${r.id}" onclick="openResume('${r.id}')">
    <label class="compare-check" onclick="event.stopPropagation();">
      <input type="checkbox" onchange="toggleCompare('${r.id}', this.checked)">
      <span class="material-symbols-rounded">check_circle</span>
    </label>
    <div class="score-badge ${scoreClass}">${r.score}</div>
    <div class="candidate-info">
      <span class="candidate-name">${escapeHtml(r.candidateName)}</span>
      <span class="file-name">${escapeHtml(r.originalName)}</span>
      <p class="reasoning">${escapeHtml(r.reasoning)}</p>
      ${renderSubScoreBars(r.subScores)}
    </div>
  </div>`);
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// --- Results ---
function renderResults(results, sessionId) {
  resultsSection.style.display = 'block';

  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (sessionId) {
    currentSessionId = sessionId;
    exportCsvBtn.style.display = 'inline-flex';
  } else {
    exportCsvBtn.style.display = 'none';
  }

  compareSelection.clear();
  updateCompareBar();

  resultsContainer.innerHTML = results
    .map((r) => {
      if (r.error) {
        return `<div class="result-card result-error">
        <div class="score-badge score-low">
          <span class="material-symbols-rounded" style="font-size:24px;">error</span>
        </div>
        <div class="candidate-info">
          <span class="candidate-name">${escapeHtml(r.originalName || 'Unknown')}</span>
          <p class="reasoning" style="color:var(--md-error)">${escapeHtml(r.error)}</p>
        </div>
      </div>`;
      }

      const scoreClass =
        r.score >= 70 ? 'score-high' : r.score >= 50 ? 'score-mid' : 'score-low';

      return `<div class="result-card" data-id="${r.id}" onclick="openResume('${r.id}')">
      <label class="compare-check" onclick="event.stopPropagation();">
        <input type="checkbox" onchange="toggleCompare('${r.id}', this.checked)">
        <span class="material-symbols-rounded">check_circle</span>
      </label>
      <div class="score-badge ${scoreClass}">${r.score}</div>
      <div class="candidate-info">
        <span class="candidate-name">${escapeHtml(r.candidateName)}</span>
        <span class="file-name">${escapeHtml(r.originalName)}</span>
        <p class="reasoning">${escapeHtml(r.reasoning)}</p>
        ${renderSubScoreBars(r.subScores)}
      </div>
    </div>`;
    })
    .join('');

  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

function openResume(id) {
  window.open(`/resume.html?id=${id}`, '_blank');
}

// --- Deploy Modal ---
const deployBtn = document.getElementById('deployBtn');
const deployModal = document.getElementById('deployModal');
const deployModalClose = document.getElementById('deployModalClose');
const deployCancelBtn = document.getElementById('deployCancelBtn');
const deploySubmitBtn = document.getElementById('deploySubmitBtn');
const deployTargetSelector = document.getElementById('deployTargetSelector');
const deployLog = document.getElementById('deployLog');

const deployForms = {
  local: document.getElementById('deployFormLocal'),
  external: document.getElementById('deployFormExternal'),
  cloud: document.getElementById('deployFormCloud'),
};

let currentDeployTarget = 'local';

function openDeployModal() {
  deployModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  resetDeployModal();
}

function closeDeployModal() {
  deployModal.classList.remove('open');
  document.body.style.overflow = '';
}

function resetDeployModal() {
  switchDeployTarget('local');
  document.getElementById('deployLocalPort').value = '3001';
  document.getElementById('deployExtHost').value = '';
  document.getElementById('deployExtPort').value = '22';
  document.getElementById('deployExtUsername').value = '';
  document.getElementById('deployExtPassword').value = '';
  document.getElementById('deployExtPath').value = '';
  document.getElementById('deployExtAppPort').value = '3000';
  document.getElementById('deployCloudHost').value = '';
  document.getElementById('deployCloudSSHPort').value = '22';
  document.getElementById('deployCloudUsername').value = '';
  document.getElementById('deployCloudKey').value = '';
  document.getElementById('deployCloudPath').value = '';
  document.getElementById('deployCloudAppPort').value = '3000';
  deployLog.innerHTML = '';
  deployLog.classList.remove('visible');
  deploySubmitBtn.disabled = false;
  deploySubmitBtn.innerHTML = '<span class="material-symbols-rounded">rocket_launch</span> Deploy';
}

deployBtn.addEventListener('click', openDeployModal);
deployModalClose.addEventListener('click', closeDeployModal);
deployCancelBtn.addEventListener('click', closeDeployModal);

deployModal.addEventListener('click', (e) => {
  if (e.target === deployModal) closeDeployModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && deployModal.classList.contains('open')) {
    closeDeployModal();
  }
});

function switchDeployTarget(target) {
  currentDeployTarget = target;
  const buttons = deployTargetSelector.querySelectorAll('button');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.target === target);
  });
  Object.keys(deployForms).forEach((key) => {
    deployForms[key].classList.toggle('visible', key === target);
  });
}

deployTargetSelector.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-target]');
  if (btn) switchDeployTarget(btn.dataset.target);
});

function addDeployLog(message, type = 'info') {
  deployLog.classList.add('visible');
  const iconMap = { info: 'info', success: 'check_circle', error: 'error' };
  const entry = document.createElement('div');
  entry.className = `deploy-log-entry log-${type}`;
  entry.innerHTML = `<span class="material-symbols-rounded">${iconMap[type] || 'info'}</span> ${escapeHtml(message)}`;
  deployLog.appendChild(entry);
  deployLog.scrollTop = deployLog.scrollHeight;
}

function validateDeployForm() {
  if (currentDeployTarget === 'local') {
    const port = parseInt(document.getElementById('deployLocalPort').value, 10);
    if (!port || port < 1024 || port > 65535) {
      addDeployLog('Invalid port. Must be between 1024 and 65535.', 'error');
      return null;
    }
    return { target: 'local', port };
  }

  if (currentDeployTarget === 'external') {
    const host = document.getElementById('deployExtHost').value.trim();
    const sshPort = parseInt(document.getElementById('deployExtPort').value, 10) || 22;
    const username = document.getElementById('deployExtUsername').value.trim();
    const credential = document.getElementById('deployExtPassword').value.trim();
    const remotePath = document.getElementById('deployExtPath').value.trim();
    const appPort = parseInt(document.getElementById('deployExtAppPort').value, 10) || 3000;

    if (!host) { addDeployLog('Host is required.', 'error'); return null; }
    if (!username) { addDeployLog('Username is required.', 'error'); return null; }
    if (!credential) { addDeployLog('Password or SSH key is required.', 'error'); return null; }
    if (!remotePath) { addDeployLog('Remote path is required.', 'error'); return null; }

    const isKey = credential.includes('-----BEGIN');
    return {
      target: 'external',
      host,
      sshPort,
      username,
      password: isKey ? undefined : credential,
      privateKey: isKey ? credential : undefined,
      remotePath,
      appPort,
    };
  }

  if (currentDeployTarget === 'cloud') {
    const host = document.getElementById('deployCloudHost').value.trim();
    const sshPort = parseInt(document.getElementById('deployCloudSSHPort').value, 10) || 22;
    const username = document.getElementById('deployCloudUsername').value.trim();
    const privateKey = document.getElementById('deployCloudKey').value.trim();
    const remotePath = document.getElementById('deployCloudPath').value.trim();
    const appPort = parseInt(document.getElementById('deployCloudAppPort').value, 10) || 3000;

    if (!host) { addDeployLog('Cloud host is required.', 'error'); return null; }
    if (!username) { addDeployLog('Username is required.', 'error'); return null; }
    if (!privateKey) { addDeployLog('SSH private key is required.', 'error'); return null; }
    if (!remotePath) { addDeployLog('Remote path is required.', 'error'); return null; }

    return {
      target: 'cloud',
      host,
      sshPort,
      username,
      privateKey,
      remotePath,
      appPort,
    };
  }

  return null;
}

deploySubmitBtn.addEventListener('click', async () => {
  deployLog.innerHTML = '';
  deployLog.classList.remove('visible');

  const config = validateDeployForm();
  if (!config) return;

  deploySubmitBtn.disabled = true;
  deploySubmitBtn.innerHTML = '<span class="spinner"></span> Deploying...';
  deployCancelBtn.disabled = true;

  addDeployLog(`Starting ${config.target} deployment...`, 'info');

  try {
    const response = await authFetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await response.json();

    if (data.steps) {
      data.steps.forEach((step) => addDeployLog(step.message, step.status));
    }

    if (!response.ok) throw new Error(data.error || 'Deployment failed');

    if (data.url) {
      addDeployLog('Deployment successful!', 'success');
      const linkEl = document.createElement('a');
      linkEl.className = 'deploy-result-link';
      linkEl.href = data.url;
      linkEl.target = '_blank';
      linkEl.innerHTML = `<span class="material-symbols-rounded">open_in_new</span> Open ${escapeHtml(data.url)}`;
      deployLog.appendChild(linkEl);
    } else {
      addDeployLog('Deployment completed.', 'success');
    }
  } catch (err) {
    addDeployLog(`Deployment failed: ${err.message}`, 'error');
  } finally {
    deploySubmitBtn.disabled = false;
    deploySubmitBtn.innerHTML = '<span class="material-symbols-rounded">rocket_launch</span> Deploy';
    deployCancelBtn.disabled = false;
  }
});

// --- Session History ---
const historyContainer = document.getElementById('historyContainer');
const historyEmpty = document.getElementById('historyEmpty');
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');

async function loadHistory() {
  try {
    const response = await authFetch('/api/sessions');
    if (!response.ok) return;
    const data = await response.json();

    if (!data.sessions || data.sessions.length === 0) {
      historyContainer.innerHTML = '';
      historyEmpty.style.display = 'block';
      return;
    }

    historyEmpty.style.display = 'none';
    historyContainer.innerHTML = data.sessions.map(s => {
      const date = new Date(s.createdAt + 'Z').toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      return `<div class="history-item" onclick="loadSession('${s.id}')">
        <div class="history-icon">
          <span class="material-symbols-rounded">work</span>
        </div>
        <div class="history-info">
          <div class="history-title">${escapeHtml(s.jobTitle)}</div>
          <div class="history-meta">${date} &bull; ${s.resumeCount} resume(s)</div>
        </div>
        <div class="history-score">Top: ${s.topScore !== null ? s.topScore : '--'}</div>
      </div>`;
    }).join('');
  } catch (err) {
    // Silently fail — history is non-critical
  }
}

async function loadSession(sessionId) {
  try {
    const response = await authFetch(`/api/sessions/${sessionId}`);
    if (!response.ok) throw new Error('Session not found');
    const data = await response.json();

    document.getElementById('jobTitle').value = data.jobTitle;
    document.getElementById('jobDescription').value = data.jobDescription;

    currentSessionId = sessionId;
    renderResults(data.results, sessionId);
    setStatus(processStatus, `Loaded session from ${new Date(data.createdAt + 'Z').toLocaleDateString()}`, 'success');
  } catch (err) {
    alert('Failed to load session: ' + err.message);
  }
}

refreshHistoryBtn.addEventListener('click', loadHistory);
loadHistory();

// --- CSV Export ---
// --- Compare Selection ---
const compareBar = document.getElementById('compareBar');
const compareCountEl = document.getElementById('compareCount');
const compareBtn = document.getElementById('compareBtn');
const compareClearBtn = document.getElementById('compareClearBtn');

function toggleCompare(id, checked) {
  if (checked) {
    if (compareSelection.size >= 3) {
      alert('Maximum 3 candidates for comparison.');
      // Uncheck the checkbox
      const card = document.querySelector(`.result-card[data-id="${id}"] .compare-check input`);
      if (card) card.checked = false;
      return;
    }
    compareSelection.add(id);
  } else {
    compareSelection.delete(id);
  }
  updateCompareBar();
}

function updateCompareBar() {
  const count = compareSelection.size;
  if (count > 0) {
    compareBar.style.display = 'flex';
    compareCountEl.textContent = `${count} selected`;
    compareBtn.disabled = count < 2;
  } else {
    compareBar.style.display = 'none';
  }
}

compareBtn.addEventListener('click', () => {
  if (compareSelection.size < 2) return;
  const ids = Array.from(compareSelection).join(',');
  window.open(`/compare.html?ids=${ids}&session=${currentSessionId || ''}`, '_blank');
});

compareClearBtn.addEventListener('click', () => {
  compareSelection.clear();
  document.querySelectorAll('.compare-check input').forEach(cb => { cb.checked = false; });
  updateCompareBar();
});

// --- CSV Export ---
document.getElementById('exportCsvBtn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  try {
    const response = await authFetch(`/api/sessions/${currentSessionId}/export/csv`);
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scores.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('CSV export failed: ' + err.message);
  }
});
