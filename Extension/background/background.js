chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;
  if (msg.action === "SCAN_PAGE") {
    handleScanRequest(msg.payload).catch(err => {
      console.error("handleScanRequest error:", err);
      chrome.runtime.sendMessage({ action: "SCAN_RESULT", status: "error", message: err.message });
    });
  }
});

async function handleScanRequest(payload = {}) {
  // payload.dataset may contain:
  // - local: { source:'local', name, ts, contentDataUrl }
  // - drive: { source:'drive', name, ts, driveFileId }
  // For now we simply forward the payload to the active tab's content script or to a backend.

  // Example: send dataset to backend
  // Replace BACKEND_API with your server endpoint
  const BACKEND_API = "https://your-backend.example.com/api/scan-url";

  try {
    // get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) throw new Error("No active tab");

    const tab = tabs[0];

    // Send dataset + tab.url to backend or directly to content script
    // Option A: forward to backend
    /*
    await fetch(BACKEND_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: tab.url, dataset: payload.dataset })
    });
    */

    // Option B: send direct to content script to apply autofill (if backend returns mapping,
    // you'd do a fetch above and send mapping to content.js)
    await chrome.tabs.sendMessage(tab.id, { action: "AUTOFILL_DATASET", dataset: payload.dataset });

    chrome.runtime.sendMessage({ action: "SCAN_RESULT", status: "success", message: "Scan delivered" });
  } catch (err) {
    console.error("Scan failed:", err);
    chrome.runtime.sendMessage({ action: "SCAN_RESULT", status: "error", message: err.message });
  }
}