// -----------------------------
// DOM Elements
// -----------------------------
const localBtn = document.getElementById('localBtn');
const driveInput = document.getElementById('driveInput');
const localSummary = document.getElementById('localSummary');
const driveSummary = document.getElementById('driveSummary');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const timestampEl = document.getElementById('timestamp');
const processFilesCheckbox = document.getElementById('processFilesCheckbox');
const processingStatus = document.getElementById('processingStatus');

// -----------------------------
// State
// -----------------------------
let config = {
  type: null,
  local: { 
    items: [],
    totalFiles: 0,
    processedData: null
  },
  drive: { 
    link: null, 
    id: null, 
    name: null, 
    type: null,
    processedData: null
  },
  lastSaved: null
};

let selectedFiles = [];
const CLIENT_ID = "683128185472-l9him8sjbo77df2mvuvelpu90p02c4qi.apps.googleusercontent.com";
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
let OAUTH_TOKEN = null;

// ---------------------------------------------------------------
// TOKEN REFRESH LOGIC (50 mins, only if tab active)
// ---------------------------------------------------------------
let tokenRefreshInterval = null;
const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

async function getOAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    if (!chrome.identity) {
      console.error("Chrome Identity API not available");
      return reject(new Error("Chrome Identity API not available"));
    }

    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        console.error("OAuth error:", chrome.runtime.lastError);
        return reject(chrome.runtime.lastError);
      }
      if (!token) {
        console.error("No token returned");
        return reject(new Error("No token returned"));
      }
      OAUTH_TOKEN = token;
      console.log("✅ OAuth token obtained successfully");
      resolve(token);
    });
  });
}

async function refreshToken() {
  try {
    console.log("Refreshing access token...");
    await getOAuthToken(false);
    console.log("Token refreshed:", OAUTH_TOKEN);
  } catch (err) {
    console.warn("Silent token refresh failed, trying interactive...", err);
    try {
      await getOAuthToken(true);
    } catch (e) {
      console.error("Interactive token refresh failed:", e);
    }
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) return;
  tokenRefreshInterval = setInterval(() => {
    if (!document.hidden) refreshToken();
  }, TOKEN_REFRESH_INTERVAL_MS);

  refreshToken();
}

function stopTokenRefresh() {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    console.log("Tab active → resume token refresh");
    startTokenRefresh();
  } else {
    console.log("Tab inactive → pause token refresh");
    stopTokenRefresh();
  }
});

// Initialize token refresh only when needed, not on page load
// Uncomment the line below if you want auto-refresh
// if (!document.hidden) startTokenRefresh();

// ---------------------------------------------------------------
// STORAGE WRAPPER
// ---------------------------------------------------------------
async function saveConfigToStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    await chrome.storage.local.set({ datasetConfig: config });
  } else {
    localStorage.setItem('datasetConfig', JSON.stringify(config));
  }
}

async function clearConfigInStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    await chrome.storage.local.remove('datasetConfig');
  } else {
    localStorage.removeItem('datasetConfig');
  }
}

async function loadConfigFromStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const data = await chrome.storage.local.get('datasetConfig');
    if (data && data.datasetConfig) {
      config = data.datasetConfig;
      if (config.lastSaved) config.lastSaved = Number(config.lastSaved);
    }
  } else {
    const stored = localStorage.getItem('datasetConfig');
    if (stored) {
      config = JSON.parse(stored);
      if (config.lastSaved) config.lastSaved = Number(config.lastSaved);
    }
  }
  
  if (config.drive && config.drive.link) {
    driveInput.value = config.drive.link;
  }
  
  updateLocalUI();
  updateDriveUI();
  updateButtons();
  updateTimestampUI();
}

// ---------------------------------------------------------------
// GOOGLE DRIVE SERVICE (ID extraction, metadata, listing, download)
// ---------------------------------------------------------------
function extractDriveId(link) {
  if (!link) return null;
  
  const patterns = [
    [/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/, "spreadsheet"],
    [/\/document\/d\/([a-zA-Z0-9_-]+)/, "document"],
    [/\/presentation\/d\/([a-zA-Z0-9_-]+)/, "presentation"],
    [/\/forms\/d\/([a-zA-Z0-9_-]+)/, "form"],
    [/\/file\/d\/([a-zA-Z0-9_-]+)/, "file"],
    [/\/folders\/([a-zA-Z0-9_-]+)/, "folder"],
    [/[?&]id=([a-zA-Z0-9_-]+)/, "file"]
  ];

  for (const [regex, type] of patterns) {
    const match = link.match(regex);
    if (match) return { id: match[1], type };
  }
  
  // Direct ID
  if (/^[a-zA-Z0-9_-]{25,}$/.test(link.trim())) {
    return { id: link.trim(), type: 'unknown' };
  }
  
  return null;
}

async function authHeaders() {
  if (!OAUTH_TOKEN) await getOAuthToken(true);
  return { Authorization: `Bearer ${OAUTH_TOKEN}` };
}

async function getDriveMetadata(id) {
  const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Failed to get metadata: ${res.status}`);
  return res.json();
}

async function listDriveFolder(id) {
  const url = `https://www.googleapis.com/drive/v3/files?q='${id}' in parents&fields=files(id,name,mimeType,size)`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Failed to list folder: ${res.status}`);
  const data = await res.json();
  return data.files || [];
}

async function downloadDriveFile(id, filename = 'driveFile') {
  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  
  // Get proper filename from metadata if not provided
  if (filename === 'driveFile') {
    try {
      const metadata = await getDriveMetadata(id);
      filename = metadata.name || 'driveFile';
    } catch (e) {
      console.warn('Could not get filename from metadata:', e);
    }
  }
  
  return new File([blob], filename, { type: blob.type });
}

async function exportGoogleDoc(id, mimeType) {
  let exportMimeType = 'text/plain';
  let extension = '.txt';
  
  // Determine export format based on Google Docs type
  if (mimeType.includes('spreadsheet')) {
    exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    extension = '.xlsx';
  } else if (mimeType.includes('document')) {
    exportMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    extension = '.docx';
  } else if (mimeType.includes('presentation')) {
    exportMimeType = 'application/pdf';
    extension = '.pdf';
  }
  
  const url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  
  const metadata = await getDriveMetadata(id);
  const filename = metadata.name + extension;
  
  return new File([blob], filename, { type: exportMimeType });
}

// ---------------------------------------------------------------
// FILE PROCESSING FUNCTIONS
// ---------------------------------------------------------------
async function extractTextFromFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  
  try {
    switch(extension) {
      case 'txt':
      case 'csv':
        return await file.text();
      
      case 'json':
        const jsonText = await file.text();
        return JSON.parse(jsonText);
      
      case 'pdf':
        return await extractFromPDF(file);
      
      case 'docx':
        return await extractFromDOCX(file);
      
      case 'xlsx':
      case 'xls':
        return await extractFromExcel(file);
      
      default:
        return await file.text();
    }
  } catch (error) {
    console.error(`Error extracting from ${file.name}:`, error);
    throw new Error(`Failed to extract from ${file.name}: ${error.message}`);
  }
}

async function extractFromPDF(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF.js library not loaded. Cannot process PDF files.');
  }
  
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + '\n\n';
  }
  
  return fullText.trim();
}

async function extractFromDOCX(file) {
  if (typeof mammoth === 'undefined') {
    throw new Error('Mammoth.js library not loaded. Cannot process DOCX files.');
  }
  
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractFromExcel(file) {
  if (typeof XLSX === 'undefined') {
    throw new Error('SheetJS library not loaded. Cannot process Excel files.');
  }
  
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  
  const result = {};
  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    result[sheetName] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  });
  
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(',').map(h => h.trim());
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    data.push(row);
  }
  
  return data;
}

function parseUnstructuredText(text) {
  const lines = text.split('\n').filter(line => line.trim());
  
  const structured = {
    type: 'unstructured_text',
    lineCount: lines.length,
    content: text,
    detectedPatterns: []
  };
  
  const kvPairs = {};
  lines.forEach(line => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      kvPairs[match[1].trim()] = match[2].trim();
      structured.detectedPatterns.push('key-value');
    }
  });
  
  if (Object.keys(kvPairs).length > 0) {
    structured.keyValuePairs = kvPairs;
  }
  
  return structured;
}

async function processFilesToJSON(files) {
  const processedData = [];
  let successCount = 0;
  let errorCount = 0;
  
  updateProcessingStatus(`Processing ${files.length} files...`);
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    
    try {
      updateProcessingStatus(`Processing ${i + 1}/${files.length}: ${file.name}...`);
      
      const extractedContent = await extractTextFromFile(file);
      const extension = file.name.split('.').pop().toLowerCase();
      
      let structuredData;
      
      if (extension === 'json') {
        structuredData = extractedContent;
      } else if (extension === 'csv') {
        structuredData = parseCSV(extractedContent);
      } else if (extension === 'xlsx' || extension === 'xls') {
        structuredData = extractedContent;
      } else {
        structuredData = parseUnstructuredText(extractedContent);
      }
      
      processedData.push({
        filename: file.name,
        fileType: file.type || 'unknown',
        extension: extension,
        size: file.size,
        lastModified: new Date(file.lastModified).toISOString(),
        extractedAt: new Date().toISOString(),
        data: structuredData
      });
      
      successCount++;
      
    } catch (error) {
      console.error(`Error processing ${file.name}:`, error);
      errorCount++;
      
      processedData.push({
        filename: file.name,
        fileType: file.type || 'unknown',
        size: file.size,
        error: error.message,
        extractedAt: new Date().toISOString()
      });
    }
  }
  
  updateProcessingStatus(
    `✅ Processed ${successCount} files successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`
  );
  
  return {
    totalFiles: files.length,
    successCount,
    errorCount,
    processedAt: new Date().toISOString(),
    files: processedData
  };
}

// ---------------------------------------------------------------
// GOOGLE DRIVE FILE PROCESSING
// ---------------------------------------------------------------
async function processDriveFiles() {
  if (!config.drive || !config.drive.id) {
    throw new Error('No Google Drive ID configured');
  }
  
  try {
    updateProcessingStatus('Fetching Google Drive metadata...');
    const metadata = await getDriveMetadata(config.drive.id);
    
    let filesToProcess = [];
    
    if (metadata.mimeType === 'application/vnd.google-apps.folder') {
      // Process folder
      updateProcessingStatus('Listing folder contents...');
      const folderFiles = await listDriveFolder(config.drive.id);
      
      updateProcessingStatus(`Found ${folderFiles.length} files in folder. Downloading...`);
      
      for (const fileInfo of folderFiles) {
        try {
          let file;
          if (fileInfo.mimeType.startsWith('application/vnd.google-apps')) {
            file = await exportGoogleDoc(fileInfo.id, fileInfo.mimeType);
          } else {
            file = await downloadDriveFile(fileInfo.id, fileInfo.name);
          }
          filesToProcess.push(file);
        } catch (err) {
          console.error(`Failed to download ${fileInfo.name}:`, err);
        }
      }
    } else {
      // Process single file
      updateProcessingStatus('Downloading file...');
      let file;
      if (metadata.mimeType.startsWith('application/vnd.google-apps')) {
        file = await exportGoogleDoc(config.drive.id, metadata.mimeType);
      } else {
        file = await downloadDriveFile(config.drive.id, metadata.name);
      }
      filesToProcess.push(file);
    }
    
    if (filesToProcess.length === 0) {
      throw new Error('No files to process');
    }
    
    // Process downloaded files
    updateProcessingStatus(`Processing ${filesToProcess.length} files...`);
    const processedData = await processFilesToJSON(filesToProcess);
    
    config.drive.processedData = processedData;
    config.drive.name = metadata.name;
    
    return processedData;
    
  } catch (error) {
    console.error('Error processing Drive files:', error);
    throw error;
  }
}

// ---------------------------------------------------------------
// UI UPDATE FUNCTIONS
// ---------------------------------------------------------------
function updateProcessingStatus(message) {
  if (processingStatus) {
    processingStatus.textContent = message;
    processingStatus.style.display = 'block';
  }
}

function clearProcessingStatus() {
  if (processingStatus) {
    processingStatus.style.display = 'none';
    processingStatus.textContent = '';
  }
}

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'Saved just now';
  const units = [
    {k: 31536000, n: 'year'},
    {k: 2592000, n: 'month'},
    {k: 86400, n: 'day'},
    {k: 3600, n: 'hour'},
    {k: 60, n: 'minute'},
    {k: 1, n: 'second'}
  ];
  for (const u of units) {
    const v = Math.floor(sec / u.k);
    if (v > 0) return `Saved ${v} ${u.n}${v>1?'s':''} ago`;
  }
  return '';
}

function updateLocalUI() {
  if (!config.local || config.local.items.length === 0) {
    localSummary.textContent = 'No local selection';
    localSummary.className = 'summary';
    return;
  }
  
  const fileCount = config.local.totalFiles;
  const itemCount = config.local.items.length;
  
  let summaryText = '';
  if (itemCount === 1 && config.local.items[0].type === 'file') {
    summaryText = `Selected: ${config.local.items[0].name}`;
  } else if (itemCount === 1 && config.local.items[0].type === 'folder') {
    summaryText = `Selected: ${config.local.items[0].name} (${fileCount} files)`;
  } else {
    summaryText = `Selected: ${itemCount} files`;
  }
  
  if (config.local.processedData) {
    summaryText += ` ✓ Processed`;
  }
  
  localSummary.textContent = summaryText;
  localSummary.className = 'summary success';
}

function updateDriveUI() {
  if (!config.drive || !config.drive.link) {
    driveSummary.textContent = 'No Drive link provided';
    driveSummary.className = 'summary';
    return;
  }
  
  const typeIcons = {
    'folder': '📁 Folder',
    'file': '📄 File',
    'spreadsheet': '📊 Google Sheet',
    'document': '📝 Google Doc',
    'presentation': '📽️ Google Slides',
    'form': '📋 Google Form',
    'unknown': '📎 Item'
  };
  const typeLabel = typeIcons[config.drive.type] || '📎 Item';
  
  let summaryText = `${typeLabel}: ${config.drive.name || 'ID ' + config.drive.id.substring(0, 20) + '...'}`;
  if (config.drive.processedData) {
    summaryText += ` ✓ Processed`;
  }
  
  driveSummary.textContent = summaryText;
  driveSummary.className = 'summary success';
}

function updateButtons() {
  if ((config.type === 'local' && config.local.items.length > 0) ||
      (config.type === 'google-drive' && config.drive.link)) {
    saveBtn.disabled = false;
  } else {
    saveBtn.disabled = true;
  }
  clearBtn.disabled = !config.lastSaved;
}

function updateTimestampUI() {
  timestampEl.textContent = config.lastSaved ? timeAgo(config.lastSaved) : '';
}

setInterval(updateTimestampUI, 30000);

// ---------------------------------------------------------------
// LOCAL FILE PICKER
// ---------------------------------------------------------------
async function pickLocal() {
  const choice = confirm('Click OK to select FOLDER, or Cancel to select FILES');
  
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  
  if (choice) {
    input.webkitdirectory = true;
  }
  
  input.onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    
    if (files.length === 0) return;
    
    selectedFiles = files;
    
    if (choice) {
      const folderName = files[0].webkitRelativePath ? 
        files[0].webkitRelativePath.split('/')[0] : 'Selected Folder';
      
      config.type = 'local';
      config.local.items = [{
        name: folderName,
        path: folderName,
        type: 'folder'
      }];
      config.local.totalFiles = files.length;
    } else {
      const items = files.map(file => ({
        name: file.name,
        path: file.name,
        size: file.size,
        type: 'file'
      }));
      
      config.type = 'local';
      config.local.items = items;
      config.local.totalFiles = files.length;
    }
    
    config.local.processedData = null;
    
    updateLocalUI();
    updateButtons();
    clearProcessingStatus();
  };
  
  input.click();
}

// ---------------------------------------------------------------
// GOOGLE DRIVE LINK HANDLER
// ---------------------------------------------------------------
function handleDriveLink() {
  const link = driveInput.value.trim();
  
  if (!link) {
    config.type = null;
    config.drive = { link: null, id: null, name: null, type: null, processedData: null };
    driveSummary.textContent = 'No Drive link provided';
    driveSummary.className = 'summary';
    updateButtons();
    return;
  }

  const extracted = extractDriveId(link);
  
  if (!extracted) {
    driveSummary.textContent = '❌ Invalid Google Drive link';
    driveSummary.className = 'summary error';
    config.type = null;
    config.drive = { link: null, id: null, name: null, type: null, processedData: null };
    updateButtons();
    return;
  }

  config.type = 'google-drive';
  config.drive.link = link;
  config.drive.id = extracted.id;
  config.drive.type = extracted.type;
  config.drive.name = null;
  config.drive.processedData = null;
  
  updateDriveUI();
  updateButtons();
}

// ---------------------------------------------------------------
// SEND TO BACKEND
// ---------------------------------------------------------------
async function sendToBackend(configData) {
  try {
    const BACKEND_URL = 'http://localhost:3000/api/dataset/configure';
    
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(configData)
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Backend error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Backend response:', result);
    return result;
  } catch (error) {
    console.error('Failed to send to backend:', error);
    throw error;
  }
}

// ---------------------------------------------------------------
// EVENT LISTENERS
// ---------------------------------------------------------------
localBtn.addEventListener('click', () => {
  pickLocal();
});

driveInput.addEventListener('input', handleDriveLink);
driveInput.addEventListener('paste', () => {
  setTimeout(handleDriveLink, 10);
});

saveBtn.addEventListener('click', async () => {
  if (!config.type) {
    alert('Please choose a dataset first');
    return;
  }
  
  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  
  try {
    // Process LOCAL files
    if (config.type === 'local' && processFilesCheckbox && processFilesCheckbox.checked && selectedFiles.length > 0) {
      saveBtn.textContent = 'Processing Local Files...';
      const processedData = await processFilesToJSON(selectedFiles);
      config.local.processedData = processedData;
      console.log('Processed local data:', processedData);
    }
    
    // Process GOOGLE DRIVE files
    if (config.type === 'google-drive' && processFilesCheckbox && processFilesCheckbox.checked) {
      saveBtn.textContent = 'Processing Drive Files...';
      const processedData = await processDriveFiles();
      console.log('Processed Drive data:', processedData);
    }
    
    config.lastSaved = Date.now();
    await saveConfigToStorage();
    updateLocalUI();
    updateDriveUI();
    updateTimestampUI();
    updateButtons();
    
    // Send to backend
    saveBtn.textContent = 'Syncing to Backend...';
    await sendToBackend(config);
    alert('✅ Configuration saved and synced to backend successfully!');
    
  } catch (error) {
    console.error('Error during save:', error);
    
    if (error.message.includes('Backend error')) {
      alert('✅ Configuration saved locally!\n\n(Backend sync unavailable - this is normal if the server is not running)');
    } else {
      alert(`❌ Error: ${error.message}`);
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
});

clearBtn.addEventListener('click', async () => {
  const confirmed = confirm('Are you sure you want to clear the configuration?');
  if (!confirmed) return;

  config = {
    type: null,
    local: { items: [], totalFiles: 0, processedData: null },
    drive: { link: null, id: null, name: null, type: null, processedData: null },
    lastSaved: null
  };
  
  selectedFiles = [];
  driveInput.value = '';
  
  await clearConfigInStorage();
  updateLocalUI();
  updateDriveUI();
  updateButtons();
  updateTimestampUI();
  clearProcessingStatus();
  
  alert('✅ Configuration cleared!');
});

// ---------------------------------------------------------------
// INITIALIZE
// ---------------------------------------------------------------
(async function init() {
  console.log('Initializing options page...');
  await loadConfigFromStorage();
})();