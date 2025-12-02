document.addEventListener("DOMContentLoaded", () => {
  const scanBtn = document.getElementById("scanBtn");
  const status = document.getElementById("status");

  // Check if elements exist
  if (!scanBtn || !status) {
    console.error("Required elements not found!");
    return;
  }

  console.log("Popup loaded successfully");

  scanBtn.addEventListener("click", async () => {
    console.log("Scan button clicked");
    
    status.innerHTML = `<div style="color: #2196F3;">🔍 Scanning form...</div>`;
    scanBtn.disabled = true;
    scanBtn.textContent = "⏳ Scanning...";

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
      console.log("🌐 Scanning URL:", currentUrl);

      status.innerHTML = `<div style="color: #2196F3;">📡 Connecting to backend server...</div>`;

      // Send URL to backend
      const response = await fetch('http://localhost:3000/scan-form', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: currentUrl })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const data = await response.json();
      console.log("✅ Backend response:", data);

      // Display results
      const fieldCount = data.fieldCount || data.fields?.length || 0;
      const buttonCount = data.buttonCount || data.buttons?.length || 0;

      status.innerHTML = `
        <div style="color: #4CAF50; padding: 10px; background: #f1f8f4; border-radius: 4px;">
          <strong>✅ Scan Complete!</strong><br><br>
          📝 <strong>Fields found:</strong> ${fieldCount}<br>
          🔘 <strong>Buttons found:</strong> ${buttonCount}<br><br>
          <small style="color: #666;">Data extracted successfully!</small>
        </div>
      `;

      // Inject content script and send data
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content.js"],
        });

        // Send field data to content script
        chrome.tabs.sendMessage(
          tab.id,
          { 
            type: "FILL_FIELDS", 
            fields: data.fields,
            buttons: data.buttons 
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn("Content script message error:", chrome.runtime.lastError.message);
            } else {
              console.log("Data sent to content script:", response);
            }
          }
        );
      } catch (scriptError) {
        console.warn("Could not inject content script:", scriptError);
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
      }
      
      status.innerHTML = `
        <div style="color: #f44336; padding: 10px; background: #ffebee; border-radius: 4px;">
          <strong>❌ Error</strong><br>
          ${errorMessage}
          ${helpText}
        </div>
      `;
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "🔎 Scan & Autofill";
    }
  });
});