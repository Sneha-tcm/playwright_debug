const express = require("express");
const cors = require("cors");
const fetch = require('node-fetch');
const { loadPage } = require("./services/playwrightservice/loadPage");
const { extractDom } = require("./services/playwrightservice/extractDom");
const { detectField } = require("./services/playwrightservice/detectField");
const {
  convertToJson,
} = require("./services/playwrightservice/convertDomToJson");
const {
  scanMultiPageForm,
} = require("./services/playwrightservice/scanMultiPageForm");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

console.log("Initializing server...");

// ========================================
// AI MAPPING CONFIGURATION
// ========================================
// ✅ FIXED: Correct API endpoint for GLM-4.6
const OLLAMA_API_KEY = "7f45a572cf934e9e8628ddbb0270ace4.dgCQnMABb_97Im-lX-O75RF3";
const API_ENDPOINT = "https://ollama.com/api/chat";
const MODEL_NAME = "glm-4.6";

const AI_MAPPING_PROMPT = `You are an AI Field-Mapping Engine tasked with generating content for form fields based on an organization dataset.

Input you will receive:

1. form_fields → JSON extracted from Playwright containing label, type, description.
2. dataset → JSON detailing organization profile, registration, projects, financials, documents, addresses, and other relevant information.

Output format: Always produce valid JSON:

{
"mappedFields": [
{
"fieldId": "<ID from form_fields>",
"label": "<label from form_fields>",
"mappedValue": "<value or generated document text>",
"valueType": "text" | "document",
"confidence": "<0-1>",
"reasoning": "<one sentence>"
}
],
"missingFields": [
{
"label": "<label from form_fields>",
"reason": "Dataset does not contain this information"
}
]
}

Mapping rules:

1. Match by meaning, not just exact label names.
2. If the field expects TEXT, provide the value from the dataset.
   * Modification allowed: If the form field requires a specific portion or format of the data (e.g., only the state from a full address), return only what the form requires.
3. If the field expects a FILE UPLOAD (PDF, DOC, certificate, project summary, registration proof, etc.):
   * Do not return file paths.
   * Generate the full document content as plain text.
   * Summaries must use only information present in the dataset.
   * Follow any suggested document format (declaration, certificate, summary) in the description.
   * Do not invent any data unless the form explicitly asks for placeholders.
4. Dates, phone numbers, and other formatted fields must be returned in the format required by the form.
5. PAN, registration numbers, addresses, and contact info must be mapped exactly, except when the form requires only a portion of the value.
6. For project-related fields, select the dataset project most relevant to the field description.
7. If data is missing, set mappedValue to null and list it in missingFields.

Important: Never return anything outside this JSON structure.`;

// ========================================
// HELPER: GET LATEST DATASET CONFIG
// ========================================
function getLatestDatasetConfig() {
  try {
    const configPath = path.join(__dirname, "dataset-configs", "dataset-config.json");
    
    if (!fs.existsSync(configPath)) {
      console.warn("⚠️ No dataset configuration found at:", configPath);
      return null;
    }

    const configData = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configData);
    
    console.log("✅ Loaded dataset config:", {
      type: config.type,
      lastSaved: config.lastSaved,
      hasProcessedData: !!config.local?.processedData
    });
    
    return config;
  } catch (error) {
    console.error("❌ Error loading dataset config:", error.message);
    return null;
  }
}

// ========================================
// AI MAPPING FUNCTION (FIXED)
// ========================================
async function performAIMapping(formSchema, datasetConfig) {
  console.log("\n🤖 Starting AI Mapping...");
  console.log("Form fields count:", Object.keys(formSchema.fields || formSchema).length);
  console.log("Dataset type:", datasetConfig?.type);
  console.log("Model:", MODEL_NAME);

  try {
    // Prepare the mapping request
    const mappingRequest = {
      form_fields: formSchema.fields || formSchema,
      dataset: datasetConfig
    };

    const userMessage = `${AI_MAPPING_PROMPT}

FORM FIELDS:
${JSON.stringify(mappingRequest.form_fields, null, 2)}

DATASET:
${JSON.stringify(mappingRequest.dataset, null, 2)}

Please map the form fields to the dataset and return ONLY valid JSON with mappedFields and missingFields.`;

    console.log("📤 Sending request to API...");
    console.log("📍 API Endpoint:", API_ENDPOINT);

    // ✅ FIXED: Correct endpoint and response format
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { 
            role: "system", 
            content: "You are an AI assistant that maps form fields to dataset values. Always respond with valid JSON only." 
          },
          { 
            role: "user", 
            content: userMessage 
          }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        stream: false
      })
    });

    console.log("📥 Response Status:", response.status);
    console.log("📥 Response OK:", response.ok);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ API Error Response:", errorText);
      
      if (response.status === 401) {
        console.error("❌ Authentication Failed!");
        console.log("💡 Check your API key at: https://open.bigmodel.cn");
        throw new Error("Invalid API key");
      } else if (response.status === 429) {
        throw new Error("Rate limit exceeded. Please wait before making more requests.");
      } else if (response.status === 402) {
        throw new Error("Insufficient credits in your account.");
      } else if (response.status === 404) {
        throw new Error("API endpoint not found. Please verify the API URL.");
      }
      
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log("📥 Received response from API");

    // ✅ FIXED: OpenAI-compatible response format
    // ✅ CORRECT - Direct message.content access
const aiContent = data.message?.content;

if (!aiContent) {
  console.error("❌ No content in API response");
  console.log("Response structure:", JSON.stringify(data, null, 2));
  throw new Error("No content in API response");
}

    console.log("Raw AI Response (first 500 chars):", aiContent.substring(0, 500));

    // Try to parse JSON from the response
    let mappingResult;
    try {
      // Remove markdown code blocks if present
      let cleanContent = aiContent.trim();
      cleanContent = cleanContent.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      mappingResult = JSON.parse(cleanContent);
      console.log("✅ Successfully parsed AI mapping result");
      console.log(`   - Mapped fields: ${mappingResult.mappedFields?.length || 0}`);
      console.log(`   - Missing fields: ${mappingResult.missingFields?.length || 0}`);
    } catch (parseError) {
      console.error("❌ Failed to parse AI response as JSON:", parseError.message);
      console.log("Response content:", aiContent);
      
      // Return a structured error response
      mappingResult = {
        error: "Failed to parse AI response",
        rawResponse: aiContent,
        mappedFields: [],
        missingFields: []
      };
    }

    return mappingResult;

  } catch (error) {
    console.error("❌ AI Mapping error:", error.message);
    
    // More detailed error logging
    if (error.code === 'ENOTFOUND') {
      console.error("💡 DNS lookup failed - check internet connection and API URL");
    } else if (error.code === 'ECONNREFUSED') {
      console.error("💡 Connection refused - API server may be down");
    } else if (error.type === 'system') {
      console.error("💡 Network error:", error.code);
    }
    
    return {
      error: error.message,
      errorType: error.code || error.type || 'unknown',
      mappedFields: [],
      missingFields: []
    };
  }
}

// ========================================
// HELPER: RUN AI MAPPING AUTOMATICALLY
// ========================================
async function runAutoAIMapping(formSchema, datasetConfig) {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 AUTO AI MAPPING INITIATED");
    console.log("=".repeat(60));
    
    if (!datasetConfig) {
      console.warn("⚠️ No dataset config available - skipping AI mapping");
      return {
        success: false,
        message: "No dataset configuration found",
        skipped: true
      };
    }

    const llmResult = await performAIMapping(formSchema, datasetConfig);
    
    // Save AI mapping result
    const mappingDir = path.join(__dirname, "ai-mappings");
    if (!fs.existsSync(mappingDir)) {
      fs.mkdirSync(mappingDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split(".")[0];
    const filename = `mapping-${timestamp}.json`;
    const filepath = path.join(mappingDir, filename);

    const mappingResult = {
      timestamp: new Date().toISOString(),
      formUrl: formSchema.url || formSchema.startUrl,
      formFieldCount: Object.keys(formSchema.fields || formSchema).length,
      datasetUsed: {
        type: datasetConfig.type,
        lastSaved: datasetConfig.lastSaved,
        summary: datasetConfig.type === "local" 
          ? `${datasetConfig.local?.totalFiles || 0} files`
          : `Google Drive ${datasetConfig.drive?.type}`
      },
      mappingResult: llmResult
    };

    fs.writeFileSync(filepath, JSON.stringify(mappingResult, null, 2));
    console.log(`✅ AI Mapping saved to: ${filename}`);
    console.log("=".repeat(60) + "\n");

    return {
      success: !llmResult.error,
      result: llmResult,
      savedTo: filename
    };
  } catch (error) {
    console.error("❌ Error in auto AI mapping:", error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ========================================
// DATASET CONFIGURATION ENDPOINT
// ========================================
app.post("/api/dataset/configure", async (req, res) => {
  try {
    const config = req.body;

    console.log("\n📦 Dataset Configuration Received:");
    console.log("Type:", config.type);

    if (config.type === "local") {
      console.log(`Local Files: ${config.local.totalFiles} files`);

      if (config.local.processedData) {
        console.log("\n📊 Processed Data Received:");
        console.log(`  - Total files: ${config.local.processedData.totalFiles}`);
        console.log(`  - Successfully processed: ${config.local.processedData.successCount}`);
        console.log(`  - Failed: ${config.local.processedData.errorCount}`);

        await saveProcessedData(config.local.processedData);
      }
    } else if (config.type === "google-drive") {
      console.log(`Google Drive ${config.drive.type}:`, config.drive.id);
    }
    
    // Save configuration to file
    const configDir = path.join(__dirname, "dataset-configs");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const filename = "dataset-config.json";
    const filepath = path.join(configDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(config, null, 2));
    console.log(`✅ Configuration saved to: ${filename}\n`);

    res.json({
      success: true,
      message: "Dataset configuration received successfully",
      savedAs: filename,
      config: {
        type: config.type,
        timestamp: config.lastSaved,
        summary: config.type === "local"
          ? `${config.local.totalFiles} local files${config.local.processedData ? " (processed)" : ""}`
          : `Google Drive ${config.drive.type}`,
      },
    });
  } catch (error) {
    console.error("❌ Error processing dataset config:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ========================================
// SAVE PROCESSED DATA
// ========================================
async function saveProcessedData(processedData) {
  try {
    const dataDir = path.join(__dirname, "processed-data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const timestamp = new Date(processedData.processedAt)
      .toISOString()
      .replace(/[:.]/g, "-")
      .split(".")[0];
    const filename = `processed-data-${timestamp}.json`;
    const filepath = path.join(dataDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(processedData, null, 2));
    console.log(`✅ Processed data saved to: ${filename}`);

    return filename;
  } catch (error) {
    console.error("❌ Error saving processed data:", error.message);
    throw error;
  }
}

// ========================================
// GET PROCESSED DATA ENDPOINT
// ========================================
app.get("/api/dataset/processed-data", async (req, res) => {
  try {
    const dataDir = path.join(__dirname, "processed-data");

    if (!fs.existsSync(dataDir)) {
      return res.json({
        success: true,
        data: [],
        message: "No processed data available",
      });
    }

    const files = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith("processed-data-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) {
      return res.json({
        success: true,
        data: [],
        message: "No processed data available",
      });
    }

    const latestFile = files[0];
    const filepath = path.join(dataDir, latestFile);
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

    res.json({
      success: true,
      data: data,
      filename: latestFile,
      availableFiles: files.length,
    });
  } catch (error) {
    console.error("❌ Error retrieving processed data:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ========================================
// FORM SCANNING ENDPOINTS WITH AUTO AI MAPPING
// ========================================

// Single page form scan
app.post("/scan-form", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  let page = null;
  let browser = null;

  try {
    console.log("\n" + "=".repeat(60));
    console.log("🔍 FORM SCAN INITIATED");
    console.log("=".repeat(60));
    console.log("URL:", url);

    page = await loadPage(url);
    browser = page.context().browser();

    const extractedData = await extractDom(page);

    let domFields, buttons, stepIndicators;
    if (Array.isArray(extractedData)) {
      domFields = extractedData;
      buttons = [];
      stepIndicators = [];
    } else {
      domFields = extractedData.fields || [];
      buttons = extractedData.buttons || [];
      stepIndicators = extractedData.stepIndicators || [];
    }

    console.log(`✓ Extracted ${domFields.length} DOM elements`);
    console.log(`✓ Found ${buttons.length} buttons`);
    console.log(`✓ Found ${stepIndicators.length} step indicators`);

    const detected = detectField(domFields);
    const finalJson = convertToJson(detected);

    const result = {
      scannedAt: new Date().toISOString(),
      url: url,
      fieldCount: Object.keys(finalJson).length,
      buttonCount: buttons.length,
      fields: finalJson,
      buttons: buttons,
      stepIndicators: stepIndicators,
    };

    // Save form schema
    const formSchemaPath = path.join(__dirname, "contact-form-schema.json");
    fs.writeFileSync(formSchemaPath, JSON.stringify(result, null, 2));
    console.log(`✅ Form schema saved to: contact-form-schema.json`);
    console.log(`   - Total fields: ${Object.keys(finalJson).length}`);
    console.log("=".repeat(60) + "\n");
    
    await browser.close();

    // ⭐ AUTOMATICALLY RUN AI MAPPING
    const datasetConfig = getLatestDatasetConfig();
    const aiMappingResult = await runAutoAIMapping(result, datasetConfig);

    res.json({
      success: true,
      scan: {
        url: url,
        fieldCount: Object.keys(finalJson).length,
        buttonCount: buttons.length,
        fields: finalJson,
        buttons: buttons,
        stepIndicators: stepIndicators,
      },
      aiMapping: aiMappingResult,
      message: `Form scanned successfully with ${Object.keys(finalJson).length} fields. ${
        aiMappingResult.success 
          ? "AI mapping completed." 
          : aiMappingResult.skipped 
            ? "AI mapping skipped - no dataset configured."
            : "AI mapping failed - check logs."
      }`
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err.stack);

    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing browser:", closeErr.message);
      }
    }

    res.status(500).json({
      error: err.message,
      type: err.name,
      stack: err.stack,
    });
  }
});

// Multi-page form scan endpoint
app.post("/scan-multi-page-form", async (req, res) => {
  const { url, maxPages } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  const config = {
    nextButtonSelector: 'button:has-text("Next"), input[value="Next"]',
    maxPages: maxPages || 10,
  };

  let page = null;
  let browser = null;

  try {
    console.log("\n" + "=".repeat(60));
    console.log("🔍 MULTI-PAGE FORM SCAN INITIATED");
    console.log("=".repeat(60));
    console.log("URL:", url);
    console.log(`Max pages: ${config.maxPages}`);

    page = await loadPage(url);
    browser = page.context().browser();

    const allPages = await scanMultiPageForm(page, config);

    const totalFields = allPages.reduce((sum, p) => sum + p.fieldCount, 0);
    const totalButtons = allPages.reduce((sum, p) => sum + (p.buttons?.length || 0), 0);

    const result = {
      scannedAt: new Date().toISOString(),
      startUrl: url,
      totalPages: allPages.length,
      totalFields: totalFields,
      totalButtons: totalButtons,
      pages: allPages,
    };

    // Save form schema
    const formSchemaPath = path.join(__dirname, "multi-page-form-schema.json");
    fs.writeFileSync(formSchemaPath, JSON.stringify(result, null, 2));
    console.log(`✅ Form schema saved to: multi-page-form-schema.json`);
    console.log(`   - Total pages: ${allPages.length}`);
    console.log(`   - Total fields: ${totalFields}`);
    console.log("=".repeat(60) + "\n");

    await browser.close();

    // ⭐ AUTOMATICALLY RUN AI MAPPING
    const datasetConfig = getLatestDatasetConfig();
    const aiMappingResult = await runAutoAIMapping(result, datasetConfig);

    res.json({
      success: true,
      scan: {
        totalPages: allPages.length,
        totalFields: totalFields,
        totalButtons: totalButtons,
        pages: allPages,
      },
      aiMapping: aiMappingResult,
      message: `Scanned ${allPages.length} pages with ${totalFields} fields. ${
        aiMappingResult.success 
          ? "AI mapping completed." 
          : aiMappingResult.skipped 
            ? "AI mapping skipped - no dataset configured."
            : "AI mapping failed - check logs."
      }`
    });
  } catch (err) {
    console.error("❌ Error:", err.message);

    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing browser:", closeErr.message);
      }
    }

    res.status(500).json({
      error: err.message,
      type: err.name,
    });
  }
});

// ========================================
// GET LATEST AI MAPPING RESULT
// ========================================
app.get("/api/ai-mapping/latest", async (req, res) => {
  try {
    const mappingDir = path.join(__dirname, "ai-mappings");

    if (!fs.existsSync(mappingDir)) {
      return res.json({
        success: true,
        data: null,
        message: "No AI mapping results available",
      });
    }

    const files = fs
      .readdirSync(mappingDir)
      .filter((f) => f.startsWith("mapping-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: "No AI mapping results available",
      });
    }

    const latestFile = files[0];
    const filepath = path.join(mappingDir, latestFile);
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

    res.json({
      success: true,
      data: data,
      filename: latestFile,
    });
  } catch (error) {
    console.error("❌ Error retrieving AI mapping:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Manual AI mapping endpoint
app.post("/run-ai-mapping", async (req, res) => {
  try {
    console.log("🚀 Running AI Mapping manually...");

    const datasetConfig = getLatestDatasetConfig();
    
    if (!datasetConfig) {
      return res.status(400).json({
        success: false,
        error: "No dataset configuration found. Please upload dataset first."
      });
    }

    // Load current form schema
    const formSchemaPath = path.join(__dirname, "contact-form-schema.json");
    if (!fs.existsSync(formSchemaPath)) {
      return res.status(400).json({
        success: false,
        error: "No form schema found. Please scan a form first."
      });
    }

    const formSchema = JSON.parse(fs.readFileSync(formSchemaPath, "utf-8"));
    const aiMappingResult = await runAutoAIMapping(formSchema, datasetConfig);

    res.json({
      success: aiMappingResult.success,
      result: aiMappingResult
    });

  } catch (error) {
    console.error("AI Mapping error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    message: "AI Autofill Backend is running!",
    version: "4.0-FIXED",
    aiProvider: "Z.AI (Zhipu AI)",
    model: MODEL_NAME,
    apiUrl: API_ENDPOINT,
    apiKeyStatus: OLLAMA_API_KEY ? "Configured ✓" : "Missing ✗",
    endpoints: {
      "GET  /": "Health check",
      "POST /api/dataset/configure": "Receive dataset configuration",
      "GET  /api/dataset/processed-data": "Get latest processed data",
      "POST /scan-form": "Scan single page form (auto AI mapping)",
      "POST /scan-multi-page-form": "Scan multi-page forms (auto AI mapping)",
      "GET  /api/ai-mapping/latest": "Get latest AI mapping result",
      "POST /run-ai-mapping": "Manually run AI mapping"
    },
  });
});

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 AI Autofill Backend Server (FIXED)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📍 Running on: http://localhost:${PORT}`);
  console.log(`📊 Version: 4.0-FIXED`);
  console.log(`🤖 AI Provider: Z.AI (Zhipu AI)`);
  console.log(`📦 Model: ${MODEL_NAME}`);
  console.log(`🔗 API URL: ${API_ENDPOINT}`);
  console.log(`🔑 API Key: ${OLLAMA_API_KEY.substring(0, 20)}...`);
  console.log(`\n✨ Features:`);
  console.log(`   ✓ Form scanning with Playwright`);
  console.log(`   ✓ Automatic AI field mapping with GLM-4.6`);
  console.log(`   ✓ Dataset management`);
  console.log(`   ✓ Multi-page form support`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`✅ Server is ready!`);
  console.log(`💡 AI mapping runs automatically after each form scan.\n`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use!`);
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down server gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});