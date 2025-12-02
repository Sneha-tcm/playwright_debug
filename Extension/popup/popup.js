document.addEventListener("DOMContentLoaded", () => {
  const scanBtn = document.getElementById("scanBtn");
  const status = document.getElementById("status");

  // Check if elements exist
  if (!scanBtn || !status) {
    console.error("Required elements not found!");
    return;
  }

  console.log("Popup loaded successfully");

  // Check if dataset is configured
  chrome.storage.local.get(['datasetConfig'], (result) => {
    if (!result.datasetConfig) {
      status.innerHTML = `
        <div style="color: #ff9800; padding: 10px; background: #fff3e0; border-radius: 4px; margin-bottom: 10px;">
          ⚠️ No dataset configured<br>
          <small>Please upload your dataset first</small>
        </div>
      `;
    } else {
      const summary = result.datasetConfig.type === "local" 
        ? `${result.datasetConfig.local?.totalFiles || 0} files`
        : "Google Drive";
      status.innerHTML = `
        <div style="color: #4CAF50; padding: 10px; background: #f1f8f4; border-radius: 4px; margin-bottom: 10px;">
          ✅ Dataset ready: ${summary}
        </div>
      `;
    }
  });

  // Scan button click handler
  scanBtn.addEventListener("click", async () => {
    console.log("Scan button clicked");
    
    status.innerHTML = `<div style="color: #2196F3;">🔍 Preparing autofill...</div>`;
    scanBtn.disabled = true;
    scanBtn.textContent = "⏳ Processing...";

    try {
      // Get current tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab || !tab.url || !tab.url.startsWith("http")) {
        status.innerHTML = `<div style="color: #f44336;">⚠️ Please open a website with a form and try again.</div>`;
        scanBtn.disabled = false;
        scanBtn.textContent = "🔎 Scan & Autofill";
        return;
      }

      const currentUrl = tab.url;
      console.log("🌐 Current URL:", currentUrl);

      // Get dataset from storage
      const storageData = await chrome.storage.local.get(['datasetConfig']);
      
      if (!storageData.datasetConfig) {
        status.innerHTML = `
          <div style="color: #ff9800; padding: 10px; background: #fff3e0; border-radius: 4px;">
            <strong>⚠️ No Dataset Found</strong><br>
            Please upload your dataset first:<br><br>
            <button id="uploadDatasetBtn" style="
              background: #2196F3;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 13px;
            ">📁 Upload Dataset</button>
          </div>
        `;
        
        // Add upload handler
        document.getElementById("uploadDatasetBtn")?.addEventListener("click", showDatasetUpload);
        
        scanBtn.disabled = false;
        scanBtn.textContent = "🔎 Scan & Autofill";
        return;
      }

      const dataset = storageData.datasetConfig;
      console.log("✅ Dataset loaded:", dataset.type);

      status.innerHTML = `<div style="color: #2196F3;">📡 Connecting to AI backend...</div>`;

      // Send request to backend for direct autofill
      const response = await fetch('http://localhost:3000/api/autofill/direct', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          url: currentUrl,
          dataset: dataset 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const data = await response.json();
      console.log("✅ Backend response:", data);

      if (!data.success) {
        throw new Error(data.error || "Autofill request failed");
      }

      status.innerHTML = `<div style="color: #2196F3;">🤖 AI is filling ${data.commands.length} fields...</div>`;

      // Inject content script and wait for it to be ready
      let contentScriptReady = false;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content.js"],
        });
        console.log("✅ Content script injected");
        contentScriptReady = true;
        
        // Wait for content script to initialize
        await sleep(1000);
      } catch (scriptError) {
        console.log("Content script injection error:", scriptError.message);
        // Content script might already be loaded
        contentScriptReady = true;
      }

      if (!contentScriptReady) {
        throw new Error("Failed to load content script");
      }

      // Try to send message with retry logic
      const maxRetries = 3;
      let retryCount = 0;
      let messageSent = false;

      while (retryCount < maxRetries && !messageSent) {
        try {
          await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(
              tab.id,
              { 
                action: "EXECUTE_AUTOFILL", 
                commands: data.commands,
                metadata: data.metadata
              },
              (response) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else if (response && response.success) {
                  console.log("✅ Autofill completed:", response);
                  resolve(response);
                } else {
                  reject(new Error("Invalid response from content script"));
                }
              }
            );
          });

          messageSent = true;
          
          // Handle successful response
          const response = await new Promise((resolve) => {
            chrome.tabs.sendMessage(
              tab.id,
              { 
                action: "EXECUTE_AUTOFILL", 
                commands: data.commands,
                metadata: data.metadata
              },
              resolve
            );
          });

          if (response && response.success) {
            const successCount = response.successCount || 0;
            const failCount = response.failCount || 0;
            
            status.innerHTML = `
              <div style="color: #4CAF50; padding: 10px; background: #f1f8f4; border-radius: 4px;">
                <strong>✅ Autofill Complete!</strong><br><br>
                ✓ <strong>Filled:</strong> ${successCount} fields<br>
                ${failCount > 0 ? `⚠ <strong>Failed:</strong> ${failCount} fields<br>` : ''}
                <br>
                <small style="color: #666;">Check the form for filled data!</small>
              </div>
            `;
            
            // Auto-close popup after 3 seconds
            setTimeout(() => {
              window.close();
            }, 3000);
          } else {
            status.innerHTML = `
              <div style="color: #ff9800; padding: 10px; background: #fff3e0; border-radius: 4px;">
                <strong>⚠️ Partial Success</strong><br>
                Some fields may not have been filled.<br>
                Check the page for results.
              </div>
            `;
          }
          
        } catch (sendError) {
          retryCount++;
          console.log(`Retry ${retryCount}/${maxRetries}: ${sendError.message}`);
          
          if (retryCount < maxRetries) {
            status.innerHTML = `<div style="color: #2196F3;">⏳ Retrying (${retryCount}/${maxRetries})...</div>`;
            await sleep(1000);
          } else {
            throw new Error("Content script not responding. Please refresh the page and try again.");
          }
        }
      }

      if (!messageSent) {
        throw new Error("Failed to communicate with content script after multiple retries");
      }

    } catch (err) {
      console.error("❌ Error:", err);
      
      let errorMessage = err.message;
      let helpText = '';
      
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        errorMessage = 'Cannot connect to backend server.';
        helpText = `
          <div style="margin-top: 10px; padding: 10px; background: #fff3cd; border-radius: 4px; font-size: 12px;">
            <strong>💡 To fix this:</strong><br>
            1. Open terminal/command prompt<br>
            2. Navigate to backend folder<br>
            3. Run: <code style="background: #eee; padding: 2px 6px; border-radius: 3px;">node server.js</code><br>
            4. Keep the terminal open<br>
            5. Try scanning again
          </div>
        `;
      } else if (err.message.includes('No dataset')) {
        helpText = `
          <div style="margin-top: 10px;">
            <button id="retryUploadBtn" style="
              background: #2196F3;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 13px;
            ">📁 Upload Dataset Now</button>
          </div>
        `;
      }
      
      status.innerHTML = `
        <div style="color: #f44336; padding: 10px; background: #ffebee; border-radius: 4px;">
          <strong>❌ Error</strong><br>
          ${errorMessage}
          ${helpText}
        </div>
      `;

      // Add retry upload handler
      document.getElementById("retryUploadBtn")?.addEventListener("click", showDatasetUpload);

    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "🔎 Scan & Autofill";
    }
  });
});

// ========================================
// SHOW DATASET UPLOAD
// ========================================
function showDatasetUpload() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".pdf,.doc,.docx,.txt,.json,.csv";
  
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    
    if (files.length === 0) return;

    const status = document.getElementById("status");
    status.innerHTML = `<div style="color: #2196F3;">📤 Processing ${files.length} files...</div>`;

    try {
      // Process files
      const processedData = await processLocalFiles(files);
      
      // Create dataset config
      const dataset = {
        type: "local",
        lastSaved: new Date().toISOString(),
        local: {
          source: "local",
          totalFiles: files.length,
          processedData: processedData
        }
      };

      // Save to chrome storage
      await chrome.storage.local.set({ datasetConfig: dataset });
      console.log("✅ Dataset saved to storage");

      // Send to backend
      const response = await fetch('http://localhost:3000/api/dataset/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataset)
      });

      if (response.ok) {
        console.log("✅ Dataset sent to backend");
      }

      status.innerHTML = `
        <div style="color: #4CAF50; padding: 10px; background: #f1f8f4; border-radius: 4px;">
          <strong>✅ Dataset Uploaded!</strong><br>
          ${files.length} files processed<br><br>
          <small>Ready to autofill forms!</small>
        </div>
      `;

    } catch (error) {
      console.error("❌ Upload error:", error);
      status.innerHTML = `
        <div style="color: #f44336; padding: 10px; background: #ffebee; border-radius: 4px;">
          <strong>❌ Upload Failed</strong><br>
          ${error.message}
        </div>
      `;
    }
  };

  input.click();
}

// ========================================
// PROCESS LOCAL FILES
// ========================================
async function processLocalFiles(files) {
  const processedFiles = [];
  
  for (const file of files) {
    try {
      const content = await readFileContent(file);
      processedFiles.push({
        name: file.name,
        type: file.type,
        size: file.size,
        content: content,
        processedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error processing ${file.name}:`, error);
      processedFiles.push({
        name: file.name,
        error: error.message,
        processedAt: new Date().toISOString()
      });
    }
  }

  return {
    totalFiles: files.length,
    successCount: processedFiles.filter(f => !f.error).length,
    errorCount: processedFiles.filter(f => f.error).length,
    files: processedFiles,
    processedAt: new Date().toISOString()
  };
}

// ========================================
// READ FILE CONTENT
// ========================================
function readFileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      // Handle JSON files
      if (file.name.endsWith('.json')) {
        try {
          resolve(JSON.parse(e.target.result));
        } catch {
          resolve(e.target.result);
        }
      } 
      // Handle text files
      else if (file.name.endsWith('.txt') || file.name.endsWith('.csv')) {
        resolve(e.target.result);
      }
      // Handle binary files (PDF, DOC, etc.)
      else {
        resolve(e.target.result); // Base64 data URL
      }
    };
    
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    
    // Read as text for text-based files, as data URL for binary files
    if (file.name.endsWith('.json') || file.name.endsWith('.txt') || file.name.endsWith('.csv')) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  });
}

// ========================================
// UTILITY FUNCTION
// ========================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}