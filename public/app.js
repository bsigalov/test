// Document type definitions with Hebrew labels
const DOCUMENT_TYPES = {
  ID_CARD: { label: 'תעודת זהות', icon: '🪪', color: '#3B82F6' },
  PASSPORT: { label: 'דרכון', icon: '📘', color: '#8B5CF6' },
  DRIVERS_LICENSE: { label: 'רישיון נהיגה', icon: '🚗', color: '#EC4899' },
  BANK_STATEMENT: { label: 'דף חשבון בנק', icon: '🏦', color: '#10B981' },
  SALARY_SLIP: { label: 'תלוש שכר', icon: '💰', color: '#F59E0B' },
  TAX_DOCUMENT: { label: 'מסמך מס', icon: '📋', color: '#EF4444' },
  UTILITY_BILL: { label: 'חשבון שירות', icon: '💡', color: '#06B6D4' },
  PROOF_OF_ADDRESS: { label: 'אישור כתובת', icon: '🏠', color: '#14B8A6' },
  EMPLOYMENT_LETTER: { label: 'אישור העסקה', icon: '💼', color: '#6366F1' },
  OTHER: { label: 'אחר', icon: '📄', color: '#6B7280' },
};

// State
let uploadedPages = [];
let classifications = [];
let groupedDocuments = [];
const debugLog = [];

// DOM elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const actions = document.getElementById('actions');
const classifyBtn = document.getElementById('classifyBtn');
const saveBtn = document.getElementById('saveBtn');
const progress = document.getElementById('progress');
const progressText = document.getElementById('progressText');
const statusMessage = document.getElementById('statusMessage');
const pagesSection = document.getElementById('pagesSection');
const pagesGrid = document.getElementById('pagesGrid');
const documentsSection = document.getElementById('documentsSection');
const documentsList = document.getElementById('documentsList');
const debugContent = document.getElementById('debugContent');
const legendGrid = document.getElementById('legendGrid');

// Initialize legend
function initLegend() {
  legendGrid.innerHTML = Object.entries(DOCUMENT_TYPES)
    .map(
      ([key, { label, icon, color }]) => `
    <div class="legend-item">
      <span class="legend-dot" style="background: ${color}"></span>
      <span>${icon}</span>
      <span class="legend-label">${label} (${key})</span>
    </div>
  `
    )
    .join('');
}

// Format file size
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Show/hide progress
function showProgress(text) {
  progress.classList.add('visible');
  progressText.textContent = text;
}

function hideProgress() {
  progress.classList.remove('visible');
}

// Show status message
function showStatus(message, type = 'success') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message visible ${type}`;
  setTimeout(() => {
    statusMessage.classList.remove('visible');
  }, 5000);
}

// Add debug entry
function addDebug(label, data) {
  const entry = {
    label,
    timestamp: new Date().toISOString(),
    data,
  };
  debugLog.push(entry);
  renderDebug();
}

function renderDebug() {
  debugContent.innerHTML = debugLog
    .map(
      (entry) => `
    <div class="debug-entry">
      <div class="debug-label">${entry.label}</div>
      <div class="debug-time">${entry.timestamp}</div>
      <pre>${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}</pre>
    </div>
  `
    )
    .join('');
}

// Drag and drop handling
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

// Handle file upload
async function handleFile(file) {
  // Show file info
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  fileInfo.classList.add('visible');

  addDebug('File Selected', {
    name: file.name,
    size: formatSize(file.size),
    type: file.type,
  });

  // Upload to server
  showProgress('Uploading and converting pages...');

  const formData = new FormData();
  formData.append('document', file);

  try {
    const startTime = Date.now();
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();
    const uploadTime = Date.now() - startTime;

    uploadedPages = data.pages;

    addDebug('Upload Complete', {
      pageCount: data.pageCount,
      fileName: data.fileName,
      fileSize: formatSize(data.fileSize),
      mimeType: data.mimeType,
      serverProcessingTime: data.processingTime + 'ms',
      totalTime: uploadTime + 'ms',
    });

    // Render page thumbnails
    renderPages();

    // Enable classify button
    actions.style.display = 'flex';
    classifyBtn.disabled = false;

    hideProgress();
    showStatus(`Successfully processed ${data.pageCount} page(s)`);
  } catch (error) {
    hideProgress();
    showStatus(error.message, 'error');
    addDebug('Upload Error', { error: error.message });
  }
}

// Render page thumbnails (before classification)
function renderPages() {
  pagesSection.classList.add('visible');
  pagesGrid.innerHTML = uploadedPages
    .map(
      (page) => `
    <div class="page-card" id="page-${page.pageNumber}">
      <img src="data:image/png;base64,${page.base64}" alt="Page ${page.pageNumber}">
      <div class="page-info">
        <div class="page-number">Page ${page.pageNumber}</div>
      </div>
    </div>
  `
    )
    .join('');
}

// Render page thumbnails with classification results
function renderClassifiedPages() {
  pagesGrid.innerHTML = uploadedPages
    .map((page) => {
      const classification = classifications.find((c) => c.page === page.pageNumber);
      if (!classification) return '';

      const docType = DOCUMENT_TYPES[classification.type] || DOCUMENT_TYPES.OTHER;

      return `
      <div class="page-card" id="page-${page.pageNumber}">
        ${classification.isFirstPage ? '<div class="new-doc-badge">NEW DOC</div>' : ''}
        <img src="data:image/png;base64,${page.base64}" alt="Page ${page.pageNumber}">
        <div class="page-info">
          <div class="page-number">Page ${page.pageNumber}</div>
          <span class="badge badge-${classification.type}">
            ${docType.icon} ${classification.type}
          </span>
          <div class="confidence">
            Confidence: ${classification.confidence} | ${docType.label}
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}

// Classify documents
classifyBtn.addEventListener('click', async () => {
  classifyBtn.disabled = true;
  showProgress('Classifying documents with Claude AI...');

  addDebug('Classification Started', {
    pageCount: uploadedPages.length,
    timestamp: new Date().toISOString(),
  });

  try {
    const startTime = Date.now();
    const response = await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pages: uploadedPages.map((p) => ({ base64: p.base64 })),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Classification failed');
    }

    const data = await response.json();
    const totalTime = Date.now() - startTime;

    classifications = data.classifications;

    addDebug('Classification Complete', {
      model: data.model,
      usage: data.usage,
      serverProcessingTime: data.processingTime + 'ms',
      totalTime: totalTime + 'ms',
      classifications: data.classifications,
    });

    addDebug('Raw API Response', data.rawResponse);

    // Render classified pages
    renderClassifiedPages();

    // Group documents
    groupedDocuments = groupIntoDocuments(classifications);

    addDebug('Document Grouping', {
      documentCount: groupedDocuments.length,
      documents: groupedDocuments.map((doc) => ({
        type: doc.type,
        pageCount: doc.pages.length,
        pages: doc.pages.map((p) => p.page),
      })),
    });

    // Render grouped documents
    renderDocuments();

    hideProgress();
    classifyBtn.disabled = false;
    saveBtn.disabled = false;
    showStatus(`Classified ${classifications.length} pages into ${groupedDocuments.length} documents`);
  } catch (error) {
    hideProgress();
    classifyBtn.disabled = false;
    showStatus(error.message, 'error');
    addDebug('Classification Error', { error: error.message });
  }
});

// Group pages into documents
function groupIntoDocuments(classificationList) {
  const documents = [];
  let currentDoc = null;

  for (const page of classificationList) {
    if (page.isFirstPage) {
      if (currentDoc) documents.push(currentDoc);
      currentDoc = {
        type: page.type,
        pages: [page],
        startPage: page.page,
      };
    } else if (currentDoc) {
      currentDoc.pages.push(page);
    } else {
      // First page but isFirstPage is false - treat as new doc
      currentDoc = {
        type: page.type,
        pages: [page],
        startPage: page.page,
      };
    }
  }
  if (currentDoc) documents.push(currentDoc);

  return documents;
}

// Render grouped documents
function renderDocuments() {
  documentsSection.classList.add('visible');
  documentsList.innerHTML = groupedDocuments
    .map((doc, index) => {
      const docType = DOCUMENT_TYPES[doc.type] || DOCUMENT_TYPES.OTHER;
      const pageRange = doc.pages.map((p) => p.page).join(', ');
      const borderColor = docType.color;

      return `
      <div class="document-group" style="border-left-color: ${borderColor}">
        <div class="doc-header">
          <span class="doc-icon">${docType.icon}</span>
          <div>
            <div class="doc-type">${doc.type}</div>
            <div class="doc-label">${docType.label}</div>
          </div>
        </div>
        <div class="doc-pages">
          Document ${index + 1} — Pages: ${pageRange} (${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''})
        </div>
      </div>
    `;
    })
    .join('');
}

// Save documents
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  showProgress('Saving documents...');

  try {
    const response = await fetch('/api/save-documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: groupedDocuments }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Save failed');
    }

    const data = await response.json();

    hideProgress();
    saveBtn.disabled = false;
    showStatus(data.message);

    addDebug('Documents Saved', {
      documentCount: data.documentCount,
      message: data.message,
    });
  } catch (error) {
    hideProgress();
    saveBtn.disabled = false;
    showStatus(error.message, 'error');
    addDebug('Save Error', { error: error.message });
  }
});

// Initialize
initLegend();
