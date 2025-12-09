
// ========================================
// CONTENT SCRIPT - DIRECT FORM AUTOFILL
// ========================================

// Prevent multiple injections
if (window.aiAutofillInjected) {
  console.log("🤖 AI Autofill already loaded, skipping duplicate injection");
} else {
  window.aiAutofillInjected = true;
  console.log("🤖 AI Autofill content script loaded");

  // Signal that content script is ready
  chrome.runtime.sendMessage({ 
    action: "CONTENT_SCRIPT_READY",
    url: window.location.href 
  }).catch(() => {
    // Ignore errors if background script isn't listening
  });
}

// ========================================
// LISTEN FOR AUTOFILL COMMANDS
// ========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📨 Message received:", request.action);

  if (request.action === "EXECUTE_AUTOFILL") {
    executeAutofill(request.commands, request.metadata)
      .then(result => {
        console.log("✅ Sending response:", result);
        sendResponse(result);
      })
      .catch(error => {
        console.error("❌ Autofill error:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  if (request.action === "PING") {
    sendResponse({ pong: true, ready: true });
    return true;
  }

  if (request.action === "AUTOFILL_DATASET") {
    // Legacy support
    console.log("Dataset received (legacy):", request.dataset);
    sendResponse({ success: true, message: "Use new direct autofill" });
    return true;
  }
});

// ========================================
// EXECUTE AUTOFILL
// ========================================
async function executeAutofill(commands, metadata) {
  console.log(`🤖 Executing autofill for ${commands.length} fields...`);
  
  // Debug: Log all form fields on the page
  console.log("📋 Available form fields on page:");
  const allInputs = document.querySelectorAll('input, textarea, select');
  allInputs.forEach(input => {
    console.log({
      tag: input.tagName,
      type: input.type,
      id: input.id,
      name: input.name,
      placeholder: input.placeholder,
      ariaLabel: input.getAttribute('aria-label')
    });
  });
  
  let successCount = 0;
  let failCount = 0;
  const results = [];

  // Show loading indicator
  showNotification("⏳ Autofilling form...", "info", 2000);

  for (const command of commands) {
    console.log(`\n🎯 Attempting to fill: ${command.fieldId}`);
    console.log(`   Selector: ${command.selector}`);
    console.log(`   Value: ${command.value}`);
    
    try {
      const result = await fillField(command);
      
      if (result.success) {
        successCount++;
        results.push({ fieldId: command.fieldId, status: "success" });
        console.log(`   ✅ Success`);
      } else {
        failCount++;
        results.push({ fieldId: command.fieldId, status: "failed", reason: result.error });
        console.warn(`   ❌ Failed: ${result.error}`);
      }

      // Small delay between fields for smoother UX
      await sleep(100);

    } catch (error) {
      failCount++;
      results.push({ fieldId: command.fieldId, status: "error", error: error.message });
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  // Show completion notification
  const message = failCount > 0 
    ? `✅ Filled ${successCount} fields, ${failCount} failed`
    : `✅ Successfully filled ${successCount} fields`;
  
  showNotification(message, failCount > 0 ? "warning" : "success", 4000);

  // Log detailed results
  console.log("📊 Autofill Results:", {
    total: commands.length,
    success: successCount,
    failed: failCount,
    details: results
  });

  return { 
    success: true, 
    successCount, 
    failCount,
    results 
  };
}

// ========================================
// FILL INDIVIDUAL FIELD
// ========================================
async function fillField(command) {
  const { value, type, fieldType, action, label } = command;

  try {
    // Use smart field finder
    const element = findFieldSmartly(command);

    if (!element) {
      return { 
        success: false, 
        error: `Element not found (tried all strategies)` 
      };
    }

    // Scroll element into view
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200);

    // Handle different field types
    if (action === "document" || type === "document") {
      return fillDocumentField(element, value, label);
    }

    if (element.tagName === "INPUT") {
      return fillInputField(element, value, fieldType);
    }

    if (element.tagName === "TEXTAREA") {
      return fillTextareaField(element, value);
    }

    if (element.tagName === "SELECT") {
      return fillSelectField(element, value);
    }

    // Fallback for other element types
    element.value = value;
    triggerEvents(element);
    highlightField(element, "success");

    return { success: true };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ========================================
// FILL INPUT FIELD
// ========================================
function fillInputField(element, value, fieldType) {
  const inputType = (element.type || "text").toLowerCase();

  // Handle checkboxes
  if (inputType === "checkbox") {
    const shouldCheck = ["yes", "true", "1", "checked"].includes(
      String(value).toLowerCase()
    );
    element.checked = shouldCheck;
    triggerEvents(element);
    highlightField(element, "success");
    return { success: true };
  }

  // Handle radio buttons
  if (inputType === "radio") {
    if (element.value === value || element.id.includes(value)) {
      element.checked = true;
      triggerEvents(element);
      highlightField(element, "success");
      return { success: true };
    }
    return { success: false, error: "Radio value mismatch" };
  }

  // Handle file inputs
  if (inputType === "file") {
    return fillDocumentField(element, value, element.name);
  }

  // Handle date inputs
  if (inputType === "date") {
    const formattedDate = formatDate(value);
    element.value = formattedDate;
    triggerEvents(element);
    highlightField(element, "success");
    return { success: true };
  }

  // Handle regular text inputs
  element.value = value;
  triggerEvents(element);
  highlightField(element, "success");
  return { success: true };
}

// ========================================
// FILL TEXTAREA FIELD
// ========================================
function fillTextareaField(element, value) {
  element.value = value;
  
  // Auto-resize if needed
  element.style.height = "auto";
  element.style.height = element.scrollHeight + "px";
  
  triggerEvents(element);
  highlightField(element, "success");
  return { success: true };
}

// ========================================
// FILL SELECT/DROPDOWN FIELD
// ========================================
function fillSelectField(element, value) {
  // Try exact match first
  let option = Array.from(element.options).find(
    opt => opt.value === value || opt.text === value
  );

  // Try case-insensitive partial match
  if (!option) {
    const searchValue = String(value).toLowerCase();
    option = Array.from(element.options).find(
      opt => opt.text.toLowerCase().includes(searchValue) ||
             opt.value.toLowerCase().includes(searchValue)
    );
  }

  if (option) {
    element.value = option.value;
    triggerEvents(element);
    highlightField(element, "success");
    return { success: true };
  }

  return { success: false, error: "Option not found in select" };
}

// ========================================
// FILL DOCUMENT/FILE FIELD
// ========================================
function fillDocumentField(element, documentContent, label) {
  // Create visual indicator for document fields
  const indicator = document.createElement("div");
  indicator.className = "ai-autofill-document-indicator";
  indicator.innerHTML = `
    <div style="
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #e7f3ff;
      border: 1px solid #2196F3;
      border-radius: 6px;
      font-size: 13px;
      color: #1976D2;
      margin-top: 8px;
    ">
      <span style="font-size: 18px;">📄</span>
      <div>
        <div style="font-weight: 600;">${label || "Document"}</div>
        <div style="font-size: 11px; opacity: 0.8;">AI-generated content ready</div>
      </div>
      <button style="
        background: #2196F3;
        color: white;
        border: none;
        padding: 4px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      ">View</button>
    </div>
  `;

  // Add click handler to view document
  const viewButton = indicator.querySelector("button");
  viewButton.onclick = (e) => {
    e.preventDefault();
    showDocumentPreview(documentContent, label);
  };

  // Insert indicator after the element
  const parent = element.parentElement;
  if (parent && !parent.querySelector(".ai-autofill-document-indicator")) {
    parent.appendChild(indicator);
  }

  // Store document content in element dataset for later use
  element.dataset.aiDocumentContent = documentContent;
  element.dataset.aiDocumentReady = "true";

  highlightField(element, "document");
  return { success: true };
}

// ========================================
// SHOW DOCUMENT PREVIEW MODAL
// ========================================
function showDocumentPreview(content, title) {
  // Create modal
  const modal = document.createElement("div");
  modal.className = "ai-autofill-modal";
  modal.innerHTML = `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
    ">
      <div style="
        background: white;
        border-radius: 12px;
        padding: 24px;
        max-width: 600px;
        max-height: 80vh;
        overflow: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="margin: 0; font-size: 18px; color: #333;">📄 ${title || "Document Preview"}</h3>
          <button style="
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #999;
          ">×</button>
        </div>
        <div style="
          background: #f5f5f5;
          padding: 16px;
          border-radius: 8px;
          font-family: monospace;
          font-size: 13px;
          line-height: 1.6;
          white-space: pre-wrap;
          max-height: 400px;
          overflow: auto;
        ">${content}</div>
        <div style="margin-top: 16px; display: flex; gap: 12px;">
          <button style="
            flex: 1;
            background: #2196F3;
            color: white;
            border: none;
            padding: 10px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
          ">Copy to Clipboard</button>
          <button style="
            flex: 1;
            background: #f5f5f5;
            color: #333;
            border: none;
            padding: 10px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
          ">Close</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Event handlers
  const closeBtn = modal.querySelectorAll("button")[0]; // X button
  const copyBtn = modal.querySelectorAll("button")[1];
  const closeBtn2 = modal.querySelectorAll("button")[2];

  closeBtn.onclick = () => modal.remove();
  closeBtn2.onclick = () => modal.remove();
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(content);
    copyBtn.textContent = "✓ Copied!";
    setTimeout(() => copyBtn.textContent = "Copy to Clipboard", 2000);
  };

  // Click outside to close
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

// ========================================
// TRIGGER EVENTS
// ========================================
function triggerEvents(element) {
  const events = ["input", "change", "blur"];
  events.forEach(eventType => {
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
  });

  // Trigger React/Vue change detection
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(element, element.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// ========================================
// HIGHLIGHT FIELD
// ========================================
function highlightField(element, type = "success") {
  const colors = {
    success: "#d4edda",
    document: "#e7f3ff",
    warning: "#fff3cd",
    error: "#f8d7da"
  };

  const originalBg = element.style.backgroundColor;
  element.style.backgroundColor = colors[type];
  element.style.transition = "background-color 0.3s";

  setTimeout(() => {
    element.style.backgroundColor = originalBg;
  }, 1500);
}

// ========================================
// SHOW NOTIFICATION
// ========================================
function showNotification(message, type = "success", duration = 3000) {
  const colors = {
    success: "#28a745",
    info: "#17a2b8",
    warning: "#ffc107",
    error: "#dc3545"
  };

  const notification = document.createElement("div");
  notification.className = "ai-autofill-notification";
  notification.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${colors[type]};
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      max-width: 400px;
      animation: slideIn 0.3s ease;
    ">
      ${message}
    </div>
  `;

  // Add animation
  const style = document.createElement("style");
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = "0";
    notification.style.transition = "opacity 0.3s";
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

// ========================================
// GENERATE ALTERNATIVE SELECTORS
// ========================================
function generateAlternativeSelectors(command) {
  const alternatives = [];
  const meta = command.metadata || {};
  
  // Try metadata fields first
  if (meta.originalId) {
    alternatives.push(`#${meta.originalId}`);
    alternatives.push(`input#${meta.originalId}`);
  }
  
  if (meta.originalName) {
    alternatives.push(`[name="${meta.originalName}"]`);
    alternatives.push(`input[name="${meta.originalName}"]`);
    alternatives.push(`textarea[name="${meta.originalName}"]`);
    alternatives.push(`select[name="${meta.originalName}"]`);
  }
  
  if (meta.ariaLabel) {
    alternatives.push(`[aria-label="${meta.ariaLabel}"]`);
  }
  
  if (meta.placeholder) {
    alternatives.push(`[placeholder="${meta.placeholder}"]`);
  }
  
  // Fallback to command fields
  if (command.fieldId) {
    alternatives.push(`#${command.fieldId}`);
    alternatives.push(`[name="${command.fieldId}"]`);
    alternatives.push(`input[name="${command.fieldId}"]`);
    alternatives.push(`textarea[name="${command.fieldId}"]`);
    alternatives.push(`select[name="${command.fieldId}"]`);
  }
  
  if (command.label) {
    alternatives.push(`[aria-label="${command.label}"]`);
    alternatives.push(`[placeholder="${command.label}"]`);
    alternatives.push(`[title="${command.label}"]`);
    
    // Try partial matches
    const labelLower = command.label.toLowerCase().replace(/\s+/g, '');
    alternatives.push(`[name*="${labelLower}"]`);
  }

  return alternatives;
}

// ========================================
// FIND ELEMENT BY LABEL (Using XPath)
// ========================================
function findElementByLabel(label) {
  // Remove common suffixes to make matching easier
  const cleanLabel = label.replace(/\s*\(required\)/gi, '').trim();
  
  // Try to find label element and get its associated input
  const labels = document.querySelectorAll('label');
  for (const labelEl of labels) {
    const labelText = labelEl.textContent.trim().replace(/\s*\(required\)/gi, '').trim();
    
    if (labelText.toLowerCase().includes(cleanLabel.toLowerCase()) ||
        cleanLabel.toLowerCase().includes(labelText.toLowerCase())) {
      
      // Try to find associated input via 'for' attribute
      const forAttr = labelEl.getAttribute('for');
      if (forAttr) {
        const input = document.getElementById(forAttr);
        if (input) {
          console.log(`   ✓ Found via label[for="${forAttr}"]`);
          return input;
        }
      }
      
      // Try to find input inside label
      const inputInside = labelEl.querySelector('input, textarea, select');
      if (inputInside) {
        console.log(`   ✓ Found input inside label`);
        return inputInside;
      }
      
      // Try next sibling
      let next = labelEl.nextElementSibling;
      let attempts = 0;
      while (next && attempts < 3) {
        if (next.tagName && next.tagName.match(/^(INPUT|TEXTAREA|SELECT)$/)) {
          console.log(`   ✓ Found as next sibling`);
          return next;
        }
        const inputInNext = next.querySelector('input, textarea, select');
        if (inputInNext) {
          console.log(`   ✓ Found input inside next sibling`);
          return inputInNext;
        }
        next = next.nextElementSibling;
        attempts++;
      }
    }
  }
  
  // Try finding by placeholder text
  const inputs = document.querySelectorAll('input, textarea, select');
  for (const input of inputs) {
    const placeholder = input.placeholder || '';
    if (placeholder.toLowerCase().includes(cleanLabel.toLowerCase()) ||
        cleanLabel.toLowerCase().includes(placeholder.toLowerCase())) {
      console.log(`   ✓ Found by placeholder match`);
      return input;
    }
  }
  
  return null;
}

// ========================================
// SMART FIELD FINDER (Contact Form 7 specific)
// ========================================
function findFieldSmartly(command) {
  const { fieldId, label, selector, metadata } = command;
  
  console.log(`   🔎 Smart search for: ${fieldId}`);
  
  // Strategy 1: Direct ID or Name match
  if (fieldId) {
    let el = document.getElementById(fieldId);
    if (el) {
      console.log(`   ✓ Found by ID: ${fieldId}`);
      return el;
    }
    
    el = document.querySelector(`[name="${fieldId}"]`);
    if (el) {
      console.log(`   ✓ Found by name: ${fieldId}`);
      return el;
    }
    
    // Contact Form 7 uses name attributes
    el = document.querySelector(`input[name="${fieldId}"], textarea[name="${fieldId}"]`);
    if (el) {
      console.log(`   ✓ Found by input[name]: ${fieldId}`);
      return el;
    }
  }
  
  // Strategy 2: Try metadata
  if (metadata) {
    if (metadata.originalName) {
      const el = document.querySelector(`[name="${metadata.originalName}"]`);
      if (el) {
        console.log(`   ✓ Found by metadata.originalName: ${metadata.originalName}`);
        return el;
      }
    }
    if (metadata.originalId) {
      const el = document.getElementById(metadata.originalId);
      if (el) {
        console.log(`   ✓ Found by metadata.originalId: ${metadata.originalId}`);
        return el;
      }
    }
  }
  
  // Strategy 3: Try original selector (safely)
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        console.log(`   ✓ Found by selector: ${selector}`);
        return el;
      }
    } catch (e) {
      console.log(`   ⚠ Invalid selector: ${selector}`);
    }
  }
  
  // Strategy 4: Find by label text
  if (label) {
    const el = findElementByLabel(label);
    if (el) return el;
  }
  
  // Strategy 5: Try partial name matching
  if (fieldId) {
    const allInputs = document.querySelectorAll('input, textarea, select');
    for (const input of allInputs) {
      if (input.name && input.name.includes(fieldId)) {
        console.log(`   ✓ Found by partial name match: ${input.name}`);
        return input;
      }
    }
  }
  
  console.log(`   ❌ Not found with any strategy`);
  return null;
}

// ========================================
// UTILITY FUNCTIONS
// ========================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    return date.toISOString().split('T')[0];
  } catch {
    return dateString;
  }
}

// ========================================
// ADD FLOATING AUTOFILL BUTTON
// ========================================
function addFloatingButton() {
  // Check if button already exists
  if (document.getElementById("ai-autofill-button")) return;

  const button = document.createElement("button");
  button.id = "ai-autofill-button";
  button.innerHTML = "🤖";
  button.title = "AI Autofill (Alt+A)";
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 999998;
    transition: all 0.2s;
  `;

  button.onmouseover = () => {
    button.style.transform = "scale(1.1)";
    button.style.boxShadow = "0 6px 16px rgba(0,0,0,0.4)";
  };
  
  button.onmouseout = () => {
    button.style.transform = "scale(1)";
    button.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
  };

  button.onclick = () => {
    chrome.runtime.sendMessage({
      action: "REQUEST_AUTOFILL",
      url: window.location.href
    });
  };

  document.body.appendChild(button);
}

// Add button when page loads
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", addFloatingButton);
} else {
  addFloatingButton();
}

// Keyboard shortcut: Alt+A
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "a") {
    e.preventDefault();
    chrome.runtime.sendMessage({
      action: "REQUEST_AUTOFILL",
      url: window.location.href
    });
  }
});

console.log("✅ AI Autofill ready - Press Alt+A or click the button");