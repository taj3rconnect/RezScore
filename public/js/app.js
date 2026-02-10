// --- Dark Mode ---
const themeToggle = document.getElementById('themeToggle');
const themeIcon = themeToggle.querySelector('.material-symbols-rounded');

function setTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeIcon.textContent = dark ? 'light_mode' : 'dark_mode';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

const savedTheme = localStorage.getItem('theme');
if (savedTheme) {
  setTheme(savedTheme === 'dark');
} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  setTheme(true);
}

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setTheme(!isDark);
});

// --- State ---
let selectedFiles = [];
let uploadedResumeIds = [];
let currentSessionId = null;
let compareSelection = new Set();
let currentResults = [];

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

// --- Toast Notifications ---
const toastContainer = document.getElementById('toastContainer');
const toastIcons = { success: 'check_circle', error: 'error', info: 'info', warning: 'warning' };

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="material-symbols-rounded toast-icon">${toastIcons[type] || 'info'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" onclick="this.parentElement.classList.add('removing'); setTimeout(() => this.parentElement.remove(), 300);">
      <span class="material-symbols-rounded" style="font-size:18px;">close</span>
    </button>
  `;
  toastContainer.appendChild(toast);
  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }
}

// --- Confirm Dialog ---
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmMessage = document.getElementById('confirmMessage');
const confirmCancel = document.getElementById('confirmCancel');
const confirmOk = document.getElementById('confirmOk');
let confirmResolve = null;

function showConfirm(message) {
  return new Promise((resolve) => {
    confirmMessage.textContent = message;
    confirmOverlay.classList.add('open');
    confirmResolve = resolve;
  });
}

confirmOk.addEventListener('click', () => {
  confirmOverlay.classList.remove('open');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});

confirmCancel.addEventListener('click', () => {
  confirmOverlay.classList.remove('open');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay) {
    confirmOverlay.classList.remove('open');
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  }
});

// --- Browse ---
browseBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length > 100) {
    showToast('Maximum 100 files allowed. Please select fewer files.', 'warning');
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

  if (jobDescriptionInput.value.trim() && !(await showConfirm('This will replace the current job description. Continue?'))) {
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
    showToast('Failed to generate job description: ' + err.message, 'error');
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

// --- JD Templates ---
const loadTemplateBtn = document.getElementById('loadTemplateBtn');
const saveTemplateBtn = document.getElementById('saveTemplateBtn');
const templateDropdown = document.getElementById('templateDropdown');
const templateList = document.getElementById('templateList');
const templateEmpty = document.getElementById('templateEmpty');
let templateDropdownOpen = false;

saveTemplateBtn.addEventListener('click', async () => {
  const title = jobTitleInput.value.trim();
  const description = jobDescriptionInput.value.trim();
  if (!title) { showToast('Enter a job title before saving.', 'warning'); return; }
  if (!description) { showToast('Enter a job description before saving.', 'warning'); return; }

  saveTemplateBtn.disabled = true;
  try {
    const response = await authFetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    saveTemplateBtn.innerHTML = '<span class="material-symbols-rounded">check</span> Saved';
    setTimeout(() => {
      saveTemplateBtn.innerHTML = '<span class="material-symbols-rounded">bookmark_add</span> Save';
    }, 2000);
  } catch (err) {
    showToast('Failed to save template: ' + err.message, 'error');
  } finally {
    saveTemplateBtn.disabled = false;
  }
});

loadTemplateBtn.addEventListener('click', async () => {
  if (templateDropdownOpen) {
    templateDropdown.style.display = 'none';
    templateDropdownOpen = false;
    return;
  }

  templateDropdown.style.display = 'block';
  templateDropdownOpen = true;
  templateList.innerHTML = '<div style="padding:16px; text-align:center;"><span class="spinner spinner-dark" style="width:18px; height:18px; border-width:2px;"></span></div>';
  templateEmpty.style.display = 'none';

  try {
    const response = await authFetch('/api/templates');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    if (!data.templates || data.templates.length === 0) {
      templateList.innerHTML = '';
      templateEmpty.style.display = 'block';
      return;
    }

    templateEmpty.style.display = 'none';
    templateList.innerHTML = data.templates.map(t => `
      <div class="template-item" data-id="${t.id}">
        <div class="template-item-info" onclick="applyTemplate('${t.id}', this)">
          <div class="template-item-title">${escapeHtml(t.title)}</div>
          <div class="template-item-desc">${escapeHtml(t.description.substring(0, 80))}${t.description.length > 80 ? '...' : ''}</div>
        </div>
        <button class="template-item-delete" onclick="event.stopPropagation(); deleteTemplate('${t.id}')" title="Delete">
          <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
        </button>
      </div>
    `).join('');

    // Store templates data for applyTemplate
    templateList._templates = data.templates;
  } catch (err) {
    templateList.innerHTML = `<div class="template-empty" style="color:var(--md-error);">Failed to load templates</div>`;
  }
});

async function applyTemplate(id) {
  const templates = templateList._templates;
  if (!templates) return;
  const t = templates.find(tp => tp.id === id);
  if (!t) return;

  if ((jobTitleInput.value.trim() || jobDescriptionInput.value.trim()) &&
      !(await showConfirm('This will replace the current job title and description. Continue?'))) {
    return;
  }

  jobTitleInput.value = t.title;
  jobDescriptionInput.value = t.description;
  generateJdBtn.disabled = !t.title.trim();
  templateDropdown.style.display = 'none';
  templateDropdownOpen = false;
}

async function deleteTemplate(id) {
  if (!(await showConfirm('Delete this template?'))) return;
  try {
    const response = await authFetch(`/api/templates/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    const item = templateList.querySelector(`[data-id="${id}"]`);
    if (item) item.remove();
    if (templateList._templates) {
      templateList._templates = templateList._templates.filter(t => t.id !== id);
    }
    if (templateList.children.length === 0) {
      templateEmpty.style.display = 'block';
    }
    showToast('Template deleted.', 'success');
  } catch (err) {
    showToast('Failed to delete template: ' + err.message, 'error');
  }
}

// Close template dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (templateDropdownOpen && !e.target.closest('#templateDropdown') && !e.target.closest('#loadTemplateBtn')) {
    templateDropdown.style.display = 'none';
    templateDropdownOpen = false;
  }
});

// --- Process (SSE streaming) ---
processBtn.addEventListener('click', async () => {
  const jobTitle = document.getElementById('jobTitle').value.trim();
  const jobDescription = document.getElementById('jobDescription').value.trim();

  if (!jobTitle) { showToast('Please enter a job title.', 'warning'); return; }
  if (!jobDescription) { showToast('Please enter a job description.', 'warning'); return; }
  if (uploadedResumeIds.length === 0) { showToast('Please upload resumes first.', 'warning'); return; }

  processBtn.disabled = true;
  processBtn.innerHTML = '<span class="spinner"></span> Processing...';
  setStatus(processStatus, `Starting AI analysis of ${uploadedResumeIds.length} resume(s)...`);

  // Show results section with skeleton loading cards
  resultsSection.style.display = 'block';
  resultsContainer.innerHTML = uploadedResumeIds.map(() =>
    `<div class="result-card skeleton-card">
      <div class="skeleton-circle skeleton"></div>
      <div style="flex:1">
        <div class="skeleton skeleton-row" style="width:50%"></div>
        <div class="skeleton skeleton-row" style="width:35%"></div>
        <div class="skeleton skeleton-row" style="width:75%"></div>
      </div>
    </div>`
  ).join('');
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
    let eventType = null;
    let dataStr = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

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
      currentResults = data.results.map(r => ({ ...r, tag: r.tag || null }));
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
  // Replace first skeleton card if one exists
  const skeleton = resultsContainer.querySelector('.skeleton-card');

  // Ensure tag field exists
  if (!r.tag) r.tag = null;

  const html = buildResultCardHtml(r, 0);

  if (skeleton) {
    skeleton.insertAdjacentHTML('afterend', html);
    skeleton.remove();
  } else {
    resultsContainer.insertAdjacentHTML('beforeend', html);
  }

  // Animate score count-up
  if (!r.error) {
    const card = resultsContainer.querySelector(`.result-card[data-id="${r.id}"]`);
    if (card) animateScoreCountUp(card.querySelector('.score-badge'), r.score);
  }

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

  // Store results for filtering
  currentResults = results;

  // Show filter toolbar
  filterToolbar.style.display = 'flex';

  // Reset filters
  filterSearch.value = '';
  filterScoreMin.value = '';
  filterScoreMax.value = '';
  filterTag.value = '';
  filterSort.value = 'score-desc';
  filterCount.textContent = '';

  resultsContainer.innerHTML = results.map((r, i) => buildResultCardHtml(r, i)).join('');

  // Animate score count-ups
  resultsContainer.querySelectorAll('.score-badge[data-score]').forEach((badge, i) => {
    setTimeout(() => animateScoreCountUp(badge, parseInt(badge.dataset.score)), i * 60 + 200);
  });

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
  // Show skeleton while loading
  historyContainer.innerHTML = Array.from({ length: 3 }, () =>
    `<div class="history-item" style="pointer-events:none;">
      <div class="skeleton-circle skeleton" style="width:40px;height:40px;"></div>
      <div style="flex:1">
        <div class="skeleton skeleton-row" style="width:50%;height:14px;"></div>
        <div class="skeleton skeleton-row" style="width:30%;height:12px;"></div>
      </div>
    </div>`
  ).join('');
  historyEmpty.style.display = 'none';

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
    historyContainer.innerHTML = data.sessions.map((s, i) => {
      const date = new Date(s.createdAt + 'Z').toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      return `<div class="history-item animate-in" onclick="loadSession('${s.id}')" style="animation-delay:${i * 50}ms">
        <div class="history-icon">
          <span class="material-symbols-rounded">work</span>
        </div>
        <div class="history-info">
          <div class="history-title">${escapeHtml(s.jobTitle)}</div>
          <div class="history-meta">${date} &bull; ${s.resumeCount} resume(s)</div>
        </div>
        <div class="history-score">Top: ${s.topScore !== null ? s.topScore : '--'}</div>
        <button class="history-delete" onclick="event.stopPropagation(); deleteSession('${s.id}')" title="Delete session">
          <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
        </button>
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
    showToast('Failed to load session: ' + err.message, 'error');
  }
}

async function deleteSession(sessionId) {
  if (!(await showConfirm('Delete this scoring session? This cannot be undone.'))) return;
  try {
    const response = await authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    showToast('Session deleted.', 'success');
    loadHistory();
  } catch (err) {
    showToast('Failed to delete session: ' + err.message, 'error');
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
      showToast('Maximum 3 candidates for comparison.', 'warning');
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
const exportCsvBtnEl = document.getElementById('exportCsvBtn');
exportCsvBtnEl.addEventListener('click', async () => {
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
    showToast('CSV export failed: ' + err.message, 'error');
  }
});

// --- Inline Name Editing ---
async function startNameEdit(el) {
  const id = el.dataset.id;
  const currentName = el.childNodes[0].textContent;
  const input = document.createElement('input');
  input.className = 'candidate-name-input';
  input.type = 'text';
  input.value = currentName;

  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();

  async function save() {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      el.innerHTML = `${escapeHtml(currentName)}<span class="material-symbols-rounded edit-hint" style="font-size:14px;">edit</span>`;
      return;
    }
    try {
      const response = await authFetch(`/api/resume/${id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateName: newName }),
      });
      if (!response.ok) throw new Error('Update failed');
      el.innerHTML = `${escapeHtml(newName)}<span class="material-symbols-rounded edit-hint" style="font-size:14px;">edit</span>`;
      showToast('Name updated.', 'success');
    } catch (err) {
      el.innerHTML = `${escapeHtml(currentName)}<span class="material-symbols-rounded edit-hint" style="font-size:14px;">edit</span>`;
      showToast('Failed to update name: ' + err.message, 'error');
    }
  }

  input.addEventListener('blur', save, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      el.innerHTML = `${escapeHtml(currentName)}<span class="material-symbols-rounded edit-hint" style="font-size:14px;">edit</span>`;
    }
  });
}

// --- Drag and Drop Reordering ---
let draggedCard = null;

resultsContainer.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.result-card[draggable="true"]');
  if (!card) return;
  draggedCard = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

resultsContainer.addEventListener('dragend', () => {
  if (draggedCard) draggedCard.classList.remove('dragging');
  draggedCard = null;
  resultsContainer.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
});

resultsContainer.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.result-card:not(.dragging)');
  resultsContainer.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  if (card) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      card.classList.add('drag-over-top');
    } else {
      card.classList.add('drag-over-bottom');
    }
  }
});

resultsContainer.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!draggedCard) return;
  const card = e.target.closest('.result-card:not(.dragging)');
  if (card) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      resultsContainer.insertBefore(draggedCard, card);
    } else {
      resultsContainer.insertBefore(draggedCard, card.nextSibling);
    }
  }
});

// --- Score Count-up Animation ---
function animateScoreCountUp(badge, target) {
  if (!badge || !target) return;
  const duration = 500;
  const start = performance.now();
  badge.classList.add('counting');
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    badge.textContent = Math.round(eased * target);
    if (progress < 1) requestAnimationFrame(tick);
    else badge.classList.remove('counting');
  }
  requestAnimationFrame(tick);
}

// --- Upload Area Drag Highlight ---
const dropArea = document.getElementById('dropArea');
dropArea.addEventListener('dragenter', (e) => { e.preventDefault(); dropArea.classList.add('drag-active'); });
dropArea.addEventListener('dragover', (e) => { e.preventDefault(); });
dropArea.addEventListener('dragleave', () => { dropArea.classList.remove('drag-active'); });
dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('drag-active');
  if (e.dataTransfer.files.length > 0) {
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 100) {
      showToast('Maximum 100 files allowed.', 'warning');
      return;
    }
    selectedFiles = files;
    renderFileList();
    uploadBtn.disabled = false;
    setStatus(uploadStatus, '');
  }
});

// --- Keyboard Shortcuts ---
const shortcutsOverlay = document.getElementById('shortcutsOverlay');
const shortcutsBtn = document.getElementById('shortcutsBtn');

function toggleShortcutHelp() {
  shortcutsOverlay.classList.toggle('open');
}

shortcutsBtn.addEventListener('click', toggleShortcutHelp);

shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutsOverlay) shortcutsOverlay.classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

  // Escape closes any open overlay
  if (e.key === 'Escape') {
    if (confirmOverlay.classList.contains('open')) {
      confirmOverlay.classList.remove('open');
      if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
      return;
    }
    if (shortcutsOverlay.classList.contains('open')) {
      shortcutsOverlay.classList.remove('open');
      return;
    }
  }

  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    if (!processBtn.disabled) processBtn.click();
  } else if (e.ctrlKey && e.key === 'u') {
    e.preventDefault();
    fileInput.click();
  } else if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    if (saveTemplateBtn) saveTemplateBtn.click();
  } else if (e.ctrlKey && e.key === 'e') {
    e.preventDefault();
    if (exportCsvBtnEl.style.display !== 'none') exportCsvBtnEl.click();
  } else if (e.key === '?' && !inInput) {
    toggleShortcutHelp();
  }
});

// --- Filter Toolbar ---
const filterToolbar = document.getElementById('filterToolbar');
const filterSearch = document.getElementById('filterSearch');
const filterScoreMin = document.getElementById('filterScoreMin');
const filterScoreMax = document.getElementById('filterScoreMax');
const filterTag = document.getElementById('filterTag');
const filterSort = document.getElementById('filterSort');
const filterClear = document.getElementById('filterClear');
const filterCount = document.getElementById('filterCount');

let filterDebounceTimer = null;

function debounceFilter() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(applyFilters, 300);
}

filterSearch.addEventListener('input', debounceFilter);
filterScoreMin.addEventListener('input', debounceFilter);
filterScoreMax.addEventListener('input', debounceFilter);
filterTag.addEventListener('change', applyFilters);
filterSort.addEventListener('change', applyFilters);

filterClear.addEventListener('click', () => {
  filterSearch.value = '';
  filterScoreMin.value = '';
  filterScoreMax.value = '';
  filterTag.value = '';
  filterSort.value = 'score-desc';
  applyFilters();
});

function applyFilters() {
  if (currentResults.length === 0) return;

  const searchTerm = filterSearch.value.trim().toLowerCase();
  const scoreMin = filterScoreMin.value ? parseInt(filterScoreMin.value) : null;
  const scoreMax = filterScoreMax.value ? parseInt(filterScoreMax.value) : null;
  const tagFilter = filterTag.value;
  const sortBy = filterSort.value;

  let filtered = currentResults.filter(r => {
    if (r.error) return false;

    // Search filter
    if (searchTerm) {
      const name = (r.candidateName || '').toLowerCase();
      const file = (r.originalName || '').toLowerCase();
      if (!name.includes(searchTerm) && !file.includes(searchTerm)) return false;
    }

    // Score filter
    if (scoreMin !== null && (r.score == null || r.score < scoreMin)) return false;
    if (scoreMax !== null && (r.score == null || r.score > scoreMax)) return false;

    // Tag filter
    if (tagFilter === 'untagged' && r.tag) return false;
    if (tagFilter && tagFilter !== 'untagged' && r.tag !== tagFilter) return false;

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'score-asc': return (a.score || 0) - (b.score || 0);
      case 'name-asc': return (a.candidateName || '').localeCompare(b.candidateName || '');
      case 'name-desc': return (b.candidateName || '').localeCompare(a.candidateName || '');
      default: return (b.score || 0) - (a.score || 0);
    }
  });

  // Update count
  filterCount.textContent = `Showing ${filtered.length} of ${currentResults.filter(r => !r.error).length}`;

  // Re-render
  renderFilteredResults(filtered);
}

function renderFilteredResults(results) {
  resultsContainer.innerHTML = results.map((r, i) => buildResultCardHtml(r, i)).join('');

  // Restore checkbox state
  compareSelection.forEach(id => {
    const cb = resultsContainer.querySelector(`.result-card[data-id="${id}"] .compare-check input`);
    if (cb) cb.checked = true;
  });

  // Animate score count-ups
  resultsContainer.querySelectorAll('.score-badge[data-score]').forEach((badge, i) => {
    setTimeout(() => animateScoreCountUp(badge, parseInt(badge.dataset.score)), i * 60 + 100);
  });
}

function buildResultCardHtml(r, i) {
  if (r.error) {
    return `<div class="result-card result-error animate-in" style="animation-delay:${i * 60}ms">
      <div class="score-badge score-low">
        <span class="material-symbols-rounded" style="font-size:24px;">error</span>
      </div>
      <div class="candidate-info">
        <span class="candidate-name">${escapeHtml(r.originalName || 'Unknown')}</span>
        <p class="reasoning" style="color:var(--md-error)">${escapeHtml(r.error)}</p>
      </div>
    </div>`;
  }

  const scoreClass = r.score >= 70 ? 'score-high' : r.score >= 50 ? 'score-mid' : 'score-low';
  const activeTag = r.tag || '';

  return `<div class="result-card animate-in" data-id="${r.id}" draggable="true" onclick="openResume('${r.id}')" style="animation-delay:${i * 60}ms">
    <label class="compare-check" onclick="event.stopPropagation();">
      <input type="checkbox" onchange="toggleCompare('${r.id}', this.checked)">
      <span class="material-symbols-rounded">check_circle</span>
    </label>
    <div class="score-badge ${scoreClass}" data-score="${r.score}">0</div>
    <div class="candidate-info">
      <span class="candidate-name candidate-name-editable" data-id="${r.id}" ondblclick="event.stopPropagation(); startNameEdit(this);">${escapeHtml(r.candidateName)}<span class="material-symbols-rounded edit-hint" style="font-size:14px;">edit</span></span>
      <span class="file-name">${escapeHtml(r.originalName)}</span>
      <p class="reasoning">${escapeHtml(r.reasoning)}</p>
      ${renderSubScoreBars(r.subScores)}
      <div class="tag-pills" onclick="event.stopPropagation();">
        <span class="tag-pill tag-shortlist${activeTag === 'shortlist' ? ' active' : ''}" onclick="toggleTag('${r.id}', 'shortlist', this)">Shortlist</span>
        <span class="tag-pill tag-maybe${activeTag === 'maybe' ? ' active' : ''}" onclick="toggleTag('${r.id}', 'maybe', this)">Maybe</span>
        <span class="tag-pill tag-reject${activeTag === 'reject' ? ' active' : ''}" onclick="toggleTag('${r.id}', 'reject', this)">Reject</span>
      </div>
    </div>
  </div>`;
}

// --- Tag Toggle ---
async function toggleTag(resumeId, tag, el) {
  const result = currentResults.find(r => r.id === resumeId);
  if (!result) return;

  const newTag = result.tag === tag ? null : tag;

  try {
    const response = await authFetch(`/api/resume/${resumeId}/tag`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: newTag }),
    });
    if (!response.ok) throw new Error('Failed to update tag');

    result.tag = newTag;

    // Update pills on the card
    const card = resultsContainer.querySelector(`.result-card[data-id="${resumeId}"]`);
    if (card) {
      card.querySelectorAll('.tag-pill').forEach(pill => pill.classList.remove('active'));
      if (newTag) {
        const activePill = card.querySelector(`.tag-${newTag}`);
        if (activePill) activePill.classList.add('active');
      }
    }
  } catch (err) {
    showToast('Failed to update tag: ' + err.message, 'error');
  }
}

// --- Bulk Tag ---
document.querySelectorAll('.bulk-tag-btn').forEach(btn => {
  btn.addEventListener('click', () => bulkTag(btn.dataset.tag));
});

async function bulkTag(tag) {
  if (compareSelection.size === 0) return;
  const ids = Array.from(compareSelection);

  try {
    const response = await authFetch('/api/resumes/bulk-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeIds: ids, tag }),
    });
    if (!response.ok) throw new Error('Bulk tag failed');

    // Update local state
    for (const id of ids) {
      const r = currentResults.find(res => res.id === id);
      if (r) r.tag = tag;
    }

    // Update UI
    for (const id of ids) {
      const card = resultsContainer.querySelector(`.result-card[data-id="${id}"]`);
      if (card) {
        card.querySelectorAll('.tag-pill').forEach(pill => pill.classList.remove('active'));
        if (tag) {
          const activePill = card.querySelector(`.tag-${tag}`);
          if (activePill) activePill.classList.add('active');
        }
      }
    }

    showToast(`Tagged ${ids.length} candidate(s) as ${tag}.`, 'success');
  } catch (err) {
    showToast('Bulk tag failed: ' + err.message, 'error');
  }
}
