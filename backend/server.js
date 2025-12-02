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
"reasoning": "<one sentence>",
"selector": "<CSS selector to find the field>"
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
8. Include a CSS selector for each field (use id, name, or aria-label).

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

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ API Error Response:", errorText);
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const aiContent = data.message?.content;

    if (!aiContent) {
      throw new Error("No content in API response");
    }

    let cleanContent = aiContent.trim();
    cleanContent = cleanContent.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    const mappingResult = JSON.parse(cleanContent);
    console.log("✅ Successfully parsed AI mapping result");
    console.log(`   - Mapped fields: ${mappingResult.mappedFields?.length || 0}`);
    console.log(`   - Missing fields: ${mappingResult.missingFields?.length || 0}`);

    return mappingResult;

  } catch (error) {
    console.error("❌ AI Mapping error:", error.message);
    return {
      error: error.message,
      mappedFields: [],
      missingFields: []
    };
  }
}

// ========================================
// TRANSFORM TO AUTOFILL COMMANDS
// ========================================
function transformToAutofillCommands(mappedFields, formFields) {
  return mappedFields
    .filter(field => field.mappedValue !== null)
    .map(field => {
      // Find the original field definition
      const originalField = formFields[field.fieldId];
      
      // Generate selector
      let selector = field.selector;
      if (!selector && originalField) {
        if (originalField.id) {
          selector = `#${originalField.id}`;
        } else if (originalField.name) {
          selector = `[name="${originalField.name}"]`;
        } else if (originalField.label) {
          selector = `[aria-label="${originalField.label}"]`;
        }
      }

      return {
        fieldId: field.fieldId,
        selector: selector || `[id="${field.fieldId}"]`,
        value: field.mappedValue,
        type: field.valueType || "text",
        fieldType: originalField?.type || "text",
        action: field.valueType === "document" ? "document" : "fill",
        label: field.label,
        confidence: field.confidence
      };
    });
}

// ========================================
// DIRECT AUTOFILL ENDPOINT
// ========================================
app.post("/api/autofill/direct", async (req, res) => {
  try {
    const { url, dataset } = req.body;

    console.log("\n🤖 Direct Autofill Request");
    console.log("URL:", url);
    console.log("Dataset provided:", !!dataset);

    // 1. Get dataset config (use provided or load saved)
    let datasetConfig = dataset || getLatestDatasetConfig();
    
    if (!datasetConfig) {
      return res.status(400).json({
        success: false,
        error: "No dataset configuration found"
      });
    }

    // 2. Check if we have cached form schema for this URL
    let formSchema;
    const formSchemaPath = path.join(__dirname, "contact-form-schema.json");
    
    if (fs.existsSync(formSchemaPath)) {
      const existingSchema = JSON.parse(fs.readFileSync(formSchemaPath, "utf-8"));
      
      // Use cached schema if URL matches
      if (existingSchema.url === url) {
        console.log("✅ Using cached form schema");
        formSchema = existingSchema;
      }
    }

    // 3. If no cached schema, scan the form
    if (!formSchema) {
      console.log("📊 Scanning form...");
      const page = await loadPage(url);
      const browser = page.context().browser();
      
      try {
        const extractedData = await extractDom(page);
        const domFields = Array.isArray(extractedData) ? extractedData : (extractedData.fields || []);
        const detected = detectField(domFields);
        const finalJson = convertToJson(detected);
        
        formSchema = {
          url: url,
          fields: finalJson,
          scannedAt: new Date().toISOString()
        };
        
        // Save for future use
        fs.writeFileSync(formSchemaPath, JSON.stringify(formSchema, null, 2));
        console.log("✅ Form schema saved");
      } finally {
        await browser.close();
      }
    }

    // 4. Run AI mapping
    console.log("🤖 Running AI mapping...");
    const aiResult = await performAIMapping(formSchema, datasetConfig);

    if (aiResult.error) {
      return res.status(500).json({
        success: false,
        error: aiResult.error
      });
    }

    // 5. Transform to autofill commands
    const autofillCommands = transformToAutofillCommands(
      aiResult.mappedFields, 
      formSchema.fields
    );

    console.log(`✅ Generated ${autofillCommands.length} autofill commands`);

    // 6. Save mapping result
    const mappingDir = path.join(__dirname, "ai-mappings");
    if (!fs.existsSync(mappingDir)) {
      fs.mkdirSync(mappingDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split(".")[0];
    const mappingResult = {
      timestamp: new Date().toISOString(),
      url: url,
      commands: autofillCommands,
      aiResult: aiResult
    };

    fs.writeFileSync(
      path.join(mappingDir, `mapping-${timestamp}.json`),
      JSON.stringify(mappingResult, null, 2)
    );

    res.json({
      success: true,
      action: "AUTOFILL",
      commands: autofillCommands,
      metadata: {
        totalFields: autofillCommands.length,
        missingFields: aiResult.missingFields?.length || 0,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("❌ Direct autofill error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
// FORM SCANNING ENDPOINTS
// ========================================
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

    const formSchemaPath = path.join(__dirname, "contact-form-schema.json");
    fs.writeFileSync(formSchemaPath, JSON.stringify(result, null, 2));
    console.log(`✅ Form schema saved`);
    
    await browser.close();

    const datasetConfig = getLatestDatasetConfig();
    const aiMappingResult = await runAutoAIMapping(result, datasetConfig);

    res.json({
      success: true,
      scan: result,
      aiMapping: aiMappingResult,
      message: `Form scanned successfully with ${Object.keys(finalJson).length} fields.`
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
// GET LATEST AI MAPPING
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

// Health check
app.get("/", (req, res) => {
  res.json({
    message: "AI Autofill Backend is running!",
    version: "5.0-DIRECT-AUTOFILL",
    aiProvider: "Z.AI (Zhipu AI)",
    model: MODEL_NAME,
    endpoints: {
      "POST /api/autofill/direct": "Get autofill commands for URL",
      "POST /api/dataset/configure": "Configure dataset",
      "POST /scan-form": "Scan form structure",
      "GET  /api/ai-mapping/latest": "Get latest mapping",
    },
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 AI Autofill Backend Server - Direct Autofill Mode`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📍 Running on: http://localhost:${PORT}`);
  console.log(`📊 Version: 5.0-DIRECT-AUTOFILL`);
  console.log(`\n✨ New Feature: Direct Autofill API`);
  console.log(`   - Endpoint: POST /api/autofill/direct`);
  console.log(`   - Returns: Ready-to-use autofill commands`);
  console.log(`${"=".repeat(60)}\n`);
});

process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});