// ========================================
// BACKGROUND SERVICE WORKER - DIRECT AUTOFILL
// ========================================

const BACKEND_URL = "http://localhost:3000"; // still supported if needed
let nativePort = null;

// ========================================
// CONNECT TO NATIVE MESSAGING HOST
// ========================================
function connectNativeHost() {
  console.log("🔌 Connecting to native host...");

  try {
    nativePort = chrome.runtime.connectNative("com.example.myhost");

    nativePort.onMessage.addListener((msg) => {
      console.log("📥 Message from Native Host:", msg);

      // If native host replied to a request
      if (msg.autofillResponse) {
        handleNativeAutofillResponse(msg.autofillResponse);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn("❌ Native host disconnected.");
      nativePort = null;
    });

    console.log("✅ Native host connected");
  } catch (err) {
    console.error("❌ Failed to connect to native host:", err);
  }
}

connectNativeHost();

function sendToNativeHost(payload) {
  if (!nativePort) {
    console.warn("⚠️ Host not connected; reconnecting...");
    connectNativeHost();
  }
  console.log("📤 Sending to Native Host:", payload);
  nativePort.postMessage(payload);
}

// ========================================
// LISTENERS FROM POPUP + CONTENT SCRIPTS
// ========================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === "SCAN_PAGE") {
    handleScanRequest(msg.payload)
      .then(sendResponse)
      .catch((err) => {
        console.error("handleScanRequest error:", err);
        sendResponse({ status: "error", message: err.message });
      });
    return true;
  }

  if (msg.action === "REQUEST_AUTOFILL") {
    handleDirectAutofill(msg.url, msg.dataset, sender.tab?.id)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ success: false, error: error.message })
      );
    return true;
  }

  if (msg.action === "GET_DATASET") {
    chrome.storage.local.get(["datasetConfig"], (result) => {
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

    // Store dataset
    if (payload.dataset) {
      await chrome.storage.local.set({ datasetConfig: payload.dataset });
      console.log("✅ Dataset stored in chrome.storage");
    }

    // Also send dataset to native host
    sendToNativeHost({
      type: "STORE_DATASET",
      dataset: payload.dataset,
    });

    // Trigger autofill
    const result = await handleDirectAutofill(url, payload.dataset, tab.id);

    return {
      status: "success",
      message: `Autofilled ${result.fieldsCount || 0} fields`,
      ...result,
    };
  } catch (err) {
    console.error("❌ Scan failed:", err);
    return {
      status: "error",
      message: err.message,
    };
  }
}

// ========================================
// HANDLE DIRECT AUTOFILL (NOW VIA NATIVE HOST)
// ========================================
async function handleDirectAutofill(url, dataset, tabId) {
  try {
    console.log("🤖 Requesting direct autofill...");
    console.log("URL:", url);
    console.log("Tab ID:", tabId);

    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) throw new Error("No active tab");
      tabId = tabs[0].id;
    }

    // Send request to Native Host
    sendToNativeHost({
      type: "AUTOFILL_REQUEST",
      url,
      dataset
    });

    // The native host will respond asynchronously
    return { success: true, waiting: true };
  } catch (error) {
    console.error("❌ Autofill error:", error);

    chrome.notifications.create({
      type: "basic",
      iconUrl: "assets/icon.png",
      title: "Autofill Failed",
      message: error.message,
    });

    return { success: false, error: error.message };
  }
}

// ========================================
// HANDLE RESPONSE FROM NATIVE HOST
// ========================================
async function handleNativeAutofillResponse(response) {
  const { commands, metadata, tabId } = response;

  console.log(`📥 Host returned ${commands.length} autofill commands`);

  await chrome.tabs.sendMessage(tabId, {
    action: "EXECUTE_AUTOFILL",
    commands,
    metadata,
  });
}

// ========================================
// CONTEXT MENU
// ========================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "autofill-form",
    title: "🤖 AI Autofill This Form",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "autofill-form") {
    console.log("🖱️ Context menu clicked - triggering autofill");

    const storage = await chrome.storage.local.get(["datasetConfig"]);
    const dataset = storage.datasetConfig;

    if (!dataset) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "assets/icon.png",
        title: "No Dataset",
        message: "Please configure a dataset first in the extension popup",
      });
      return;
    }

    sendToNativeHost({
      type: "AUTOFILL_REQUEST",
      url: tab.url,
      dataset,
      tabId: tab.id,
    });
  }
});

// ========================================
// KEYBOARD SHORTCUT
// ========================================
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "trigger-autofill") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      const storage = await chrome.storage.local.get(["datasetConfig"]);
      sendToNativeHost({
        type: "AUTOFILL_REQUEST",
        url: tabs[0].url,
        dataset: storage.datasetConfig,
        tabId: tabs[0].id,
      });
    }
  }
});

console.log("✅ Background service worker initialized with Native Messaging");
