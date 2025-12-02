// messaging.js
console.log("📡 messaging.js loaded");

/**
 * Send a message to the background script or content script.
 * @param {Object} message - The message payload { type: string, data?: any }
 * @returns {Promise<any>} - The response from the receiver
 */
export async function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error("❌ Message send failed:", chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      console.error("❌ Error sending message:", err);
      reject(err);
    }
  });
}

/**
 * Listen for incoming messages.
 * @param {(message: any, sender: chrome.runtime.MessageSender, sendResponse: Function) => void | boolean} handler
 */
export function onMessage(handler) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      const maybePromise = handler(message, sender, sendResponse);

      // If the handler returns a Promise, handle async properly
      if (maybePromise instanceof Promise) {
        maybePromise
          .then((result) => sendResponse(result))
          .catch((err) => {
            console.error("❌ Message handler error:", err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // Keeps the message channel open for async response
      }

      // If handler returns synchronously
      return maybePromise;
    } catch (err) {
      console.error("❌ Message handling error:", err);
      sendResponse({ success: false, error: err.message });
      return false;
    }
  });
}
