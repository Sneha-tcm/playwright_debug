const CLIENT_ID = "683128185472-l9him8sjbo77df2mvuvelpu90p02c4qi.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

let accessToken = null;

// STEP 1 — Dynamically load Google API scripts (CSP-safe)
function loadGoogleScripts() {
  loadScript("https://apis.google.com/js/api.js", () => {
    loadScript("https://accounts.google.com/gsi/client", initPickerAuth);
  });
}

// Helper to load external scripts dynamically
function loadScript(url, callback) {
  const script = document.createElement("script");
  script.src = url;
  script.onload = callback;
  document.head.appendChild(script);
}

// STEP 2 — Initialize OAuth
function initPickerAuth() {
  google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (response) => {
      accessToken = response.access_token;
      loadPicker();
    }
  }).requestAccessToken();
}

// STEP 3 — Load Google Picker
function loadPicker() {
  gapi.load("picker", showPicker);
}

// STEP 4 — Show Picker
function showPicker() {
  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(accessToken)
    .addView(google.picker.ViewId.FOLDERS)
    .setCallback(pickerCallback)
    .build();

  picker.setVisible(true);
}

// STEP 5 — Send selected folder back to options page
function pickerCallback(data) {
  if (data.action === google.picker.Action.PICKED) {
    const folder = data.docs[0];

    window.opener.postMessage({
      type: "DRIVE_PICKED",
      id: folder.id,
      name: folder.name
    }, "*");

    window.close();
  }
}

// START
loadGoogleScripts();
