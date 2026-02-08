// --- State ---
let selectedFiles = [];
let uploadedResumeIds = [];

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
  if (files.length > 10) {
    alert('Maximum 10 files allowed. Please select fewer files.');
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
    const response = await fetch('/api/upload', {
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

// --- Process ---
processBtn.addEventListener('click', async () => {
  const jobTitle = document.getElementById('jobTitle').value.trim();
  const jobDescription = document.getElementById('jobDescription').value.trim();

  if (!jobTitle) {
    alert('Please enter a job title.');
    return;
  }
  if (!jobDescription) {
    alert('Please enter a job description.');
    return;
  }
  if (uploadedResumeIds.length === 0) {
    alert('Please upload resumes first.');
    return;
  }

  processBtn.disabled = true;
  processBtn.innerHTML = '<span class="spinner"></span> Processing...';
  setStatus(
    processStatus,
    `Analyzing ${uploadedResumeIds.length} resume(s) with AI... This may take a moment.`
  );
  resultsSection.style.display = 'none';

  try {
    const response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeIds: uploadedResumeIds,
        jobTitle,
        jobDescription,
      }),
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error);

    renderResults(data.results);
    setStatus(processStatus, 'Processing complete!', 'success');
  } catch (err) {
    setStatus(processStatus, `Processing failed: ${err.message}`, 'error');
  } finally {
    processBtn.innerHTML = '<span class="material-symbols-rounded">auto_awesome</span> Process with AI';
    processBtn.disabled = false;
  }
});

// --- Results ---
function renderResults(results) {
  resultsSection.style.display = 'block';

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

      return `<div class="result-card" onclick="openResume('${r.id}')">
      <div class="score-badge ${scoreClass}">${r.score}</div>
      <div class="candidate-info">
        <span class="candidate-name">${escapeHtml(r.candidateName)}</span>
        <span class="file-name">${escapeHtml(r.originalName)}</span>
        <p class="reasoning">${escapeHtml(r.reasoning)}</p>
      </div>
    </div>`;
    })
    .join('');

  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

function openResume(id) {
  window.open(`/resume.html?id=${id}`, '_blank');
}
