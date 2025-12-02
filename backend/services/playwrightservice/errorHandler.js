// backend/services/playwrightService/errorHandler.js
function handleError(err) {
    console.error("Playwright Error:", err.message);
    throw err; // can be handled in controller
}

module.exports = { handleError };
