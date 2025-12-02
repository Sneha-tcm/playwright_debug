// ========================================
// BACKGROUND SERVICE WORKER - DIRECT AUTOFILL
// ========================================

const BACKEND_URL = "http://localhost:3000";

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === "SCAN_PAGE") {
    handleScanRequest(msg.payload)
      .then(sendResponse)
      .catch(err => {
        console.error("handleScanRequest error:", err);
        sendResponse({ status: "error", message: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (msg.action === "REQUEST_AUTOFILL") {
    handleDirectAutofill(msg.url, msg.dataset, sender.tab?.id)
      .then(sendResponse)
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (msg.action === "GET_DATASET") {
    // Return stored dataset from chrome.storage
    chrome.storage.local.get(['datasetConfig'], (result) => {
      sendResponse({ dataset: result.datasetConfig || null });
    });
    return true;
  }
});

// ========================================
// HANDLE SCAN REQUEST (FROM POPUP)
// ========================================
async function handleScanRequest(payload = {}) {
  try {
    console.log("📊 Handling scan request with dataset:", payload.dataset?.source);

    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) throw new Error("No active tab");

    const tab = tabs[0];
    const url = tab.url;

    // Store dataset in chrome.storage for later use
    if (payload.dataset) {
      await chrome.storage.local.set({ datasetConfig: payload.dataset });
      console.log("✅ Dataset stored in chrome.storage");
    }

    // Send dataset to backend for configuration
    if (payload.dataset) {
      await fetch(`${BACKEND_URL}/api/dataset/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.dataset)
      });
      console.log("✅ Dataset sent to backend");
    }

    // Trigger autofill immediately
    const result = await handleDirectAutofill(url, payload.dataset, tab.id);

    return {
      status: "success",
      message: `Autofilled ${result.fieldsCount || 0} fields`,
      ...result
    };

  } catch (err) {
    console.error("❌ Scan failed:", err);
    return {
      status: "error",
      message: err.message
    };
  }
}

// ========================================
// HANDLE DIRECT AUTOFILL
// ========================================
async function handleDirectAutofill(url, dataset, tabId) {
  try {
    console.log("🤖 Requesting direct autofill...");
    console.log("URL:", url);
    console.log("Tab ID:", tabId);

    // If no tabId provided, get active tab
    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) throw new Error("No active tab");
      tabId = tabs[0].id;
    }

    // Call backend for autofill commands
    const response = await fetch(`${BACKEND_URL}/api/autofill/direct`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        url: url,
        dataset: dataset 
      })
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Autofill request failed");
    }

    console.log(`✅ Received ${data.commands.length} autofill commands`);

    // Send commands to content script for execution
    await chrome.tabs.sendMessage(tabId, {
      action: "EXECUTE_AUTOFILL",
      commands: data.commands,
      metadata: data.metadata
    });

    return { 
      success: true, 
      fieldsCount: data.commands.length,
      metadata: data.metadata
    };

  } catch (error) {
    console.error("❌ Autofill error:", error);
    
    // Show error notification to user
    chrome.notifications.create({
      type: "basic",
      iconUrl: "assets/icon.png",
      title: "Autofill Failed",
      message: error.message
    });

    return { 
      success: false, 
      error: error.message 
    };
  }
}

// ========================================
// CONTEXT MENU - RIGHT CLICK AUTOFILL
// ========================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "autofill-form",
    title: "🤖 AI Autofill This Form",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "autofill-form") {
    console.log("🖱️ Context menu clicked - triggering autofill");

    // Get stored dataset
    const storage = await chrome.storage.local.get(['datasetConfig']);
    const dataset = storage.datasetConfig;

    if (!dataset) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "assets/icon.png",
        title: "No Dataset",
        message: "Please configure a dataset first in the extension popup"
      });
      return;
    }

    // Trigger autofill
    await handleDirectAutofill(tab.url, dataset, tab.id);
  }
});

// ========================================
// KEYBOARD SHORTCUT (OPTIONAL)
// ========================================
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "trigger-autofill") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      const storage = await chrome.storage.local.get(['datasetConfig']);
      await handleDirectAutofill(tabs[0].url, storage.datasetConfig, tabs[0].id);
    }
  }
});

console.log("✅ Background service worker initialized");