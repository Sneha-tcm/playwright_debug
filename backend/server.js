require("dotenv").config();
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
// AI MAPPING CONFIGURATION - FIXED
// ========================================

// FIXED: Use correct model name
const MODEL_NAME = "ministral-3:14b";

// FIXED: Use v1 endpoint for stable models
const API_ENDPOINT = "https://ollama.com/api/generate";

const AI_MAPPING_PROMPT = `You are an AI Field-Mapping Engine. Generate ONLY valid JSON with no additional text.

INPUT:
1. form_fields - JSON with label, type, description
2. dataset - Organization data (profile, registration, projects, financials, documents, addresses)

OUTPUT FORMAT (STRICTLY VALID JSON):
{
  "mappedFields": [
    {
      "fieldId": "string",
      "label": "string",
      "mappedValue": "string or null",
      "valueType": "text or document",
      "confidence": "0.0-1.0",
      "reasoning": "brief explanation",
      "selector": "CSS selector"
    }
  ],
  "missingFields": [
    {
      "label": "string",
      "reason": "explanation"
    }
  ]
}

MAPPING RULES:
1. Match by meaning, not exact labels
2. For TEXT fields: provide exact value from dataset
3. For FILE UPLOAD fields: generate full document content as text (no file paths)
4. Format dates/phone numbers as required by form
5. Map PAN, registration numbers, addresses exactly (or portion if form requires it)
6. For project fields: select most relevant project from dataset
7. If data missing: set mappedValue to null and add to missingFields
8. Include CSS selector for each field (use id, name, or aria-label)

CRITICAL: Return ONLY the JSON object. No explanations, no markdown, no extra text.`;

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

function chunkFields(fields, size = 10) {
  const entries = Object.entries(fields);
  const chunks = [];

  for (let i = 0; i < entries.length; i += size) {
    const chunk = Object.fromEntries(entries.slice(i, i + size));
    chunks.push(chunk);
  }

  return chunks;
}

// ========================================
// AI MAPPING FUNCTION - FIXED
//==========================================
async function performAIMapping(formSchema, datasetConfig) {
  console.log("\n🤖 Starting AI Mapping with Ollama Cloud...");

  try {
    const promptText = `${AI_MAPPING_PROMPT}

FORM FIELDS:
${JSON.stringify(formSchema.fields || formSchema, null, 2)}

DATASET:
${JSON.stringify(datasetConfig, null, 2)}

IMPORTANT: Your response must be ONLY a valid JSON object starting with { and ending with }.`;

    console.log("📤 Sending request to Ollama Cloud...");
    console.log("📏 Prompt length:", promptText.length);

    const response = await fetch(API_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OLLAMA_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL_NAME, 
          messages: [
            { role: "user", content: promptText }
          ],
          temperature: 0.1,
          max_tokens: 4096
        }),
      }
    )

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ API Error Response:", errorText);
      throw new Error(`Ollama Cloud Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    const textOutput = data?.choices?.[0]?.message?.content;
    if (!textOutput) throw new Error("Ollama Cloud returned no content.");

    let cleanText = textOutput.replace(/```json|```/g, "").trim();

    const first = cleanText.indexOf("{");
    const last = cleanText.lastIndexOf("}");
    cleanText = cleanText.substring(first, last + 1);

    return JSON.parse(cleanText);

  } catch (err) {
    console.error("❌ Ollama Cloud Mapping Error:", err.message);
    return { error: err.message, mappedFields: [], missingFields: [] };
  }
}


async function performChunkedMapping(formSchema, datasetConfig) {
  console.log("🔄 Running Chunked AI Mapping...");

  const chunks = chunkFields(formSchema.fields, 6); // Smaller chunks for reliability

  let finalMapped = [];
  let finalMissing = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`\n📦 Processing Chunk ${i + 1}/${chunks.length} (${Object.keys(chunks[i]).length} fields)...`);

    const partialSchema = { fields: chunks[i] };

    try {
      const result = await performAIMapping(partialSchema, datasetConfig);

      if (!result.error && result.mappedFields) {
        finalMapped.push(...(result.mappedFields || []));
        finalMissing.push(...(result.missingFields || []));
        successCount++;
        console.log(`   ✅ Chunk ${i + 1} mapped: ${result.mappedFields.length} fields`);
      } else {
        console.error(`   ❌ Chunk ${i + 1} failed:`, result.error);
        failCount++;
      }
    } catch (error) {
      console.error(`   ❌ Chunk ${i + 1} exception:`, error.message);
      failCount++;
    }
    
    // Add delay between chunks to avoid rate limiting
    if (i < chunks.length - 1) {
      console.log(`   ⏳ Waiting 1 second before next chunk...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n📊 Chunked Mapping Summary:`);
  console.log(`   ✅ Successful chunks: ${successCount}/${chunks.length}`);
  console.log(`   ❌ Failed chunks: ${failCount}/${chunks.length}`);
  console.log(`   📝 Total fields mapped: ${finalMapped.length}`);
  console.log(`   ❓ Total missing fields: ${finalMissing.length}`);

  return {
    mappedFields: finalMapped,
    missingFields: finalMissing,
    chunkedProcessing: true,
    totalChunks: chunks.length,
    successfulChunks: successCount
  };
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
        selector: selector || [id="${field.fieldId}"],
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
      }finally {
  if (page) {
    console.log("🔌 Closing Playwright context only (user Chrome stays open)");
    await page.context().close();    // ✔ Correct
  }
}
    }
    // 4. Run AI mapping
    console.log("🤖 Running AI mapping...");
    
    // Check if form is too large and needs chunking
    const fieldCount = Object.keys(formSchema.fields).length;
    console.log(`📋 Total fields to map: ${fieldCount}`);
    
    let aiResult;
    if (fieldCount > 10) {  // Changed from 15 to 10 for better reliability
      console.log("⚠️ Large form detected, using chunked mapping...");
      aiResult = await performChunkedMapping(formSchema, datasetConfig);
    } else {
      aiResult = await performAIMapping(formSchema, datasetConfig);
    }

    if (aiResult.error && !aiResult.mappedFields?.length) {
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

    const fieldCount = Object.keys(formSchema.fields || formSchema).length;
    console.log(`📋 Total fields: ${fieldCount}`);
    
    let llmResult;
    if (fieldCount > 10) {
      console.log("🔄 Using chunked mapping for large form...");
      llmResult = await performChunkedMapping(formSchema, datasetConfig);
    } else {
      llmResult = await performAIMapping(formSchema, datasetConfig);
    }
    
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
      formFieldCount: fieldCount,
      chunkedProcessing: llmResult.chunkedProcessing || false,
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
      success: !llmResult.error || (llmResult.mappedFields && llmResult.mappedFields.length > 0),
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
    
    // Check field count and decide on chunking
    const fieldCount = Object.keys(result.fields).length;
    console.log(`📋 Form has ${fieldCount} fields`);
    
    let aiMappingResult;
    if (fieldCount > 10) {
      console.log("⚠️ Large form detected, will use chunked mapping");
      aiMappingResult = await runAutoAIMapping(result, datasetConfig);
    } else {
      aiMappingResult = await runAutoAIMapping(result, datasetConfig);
    }

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
    version: "5.0-DIRECT-AUTOFILL-FIXED",
    aiProvider: "Google Gemini",
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
  console.log(`🌐 Running on: http://localhost:${PORT}`);
  console.log(`📊 Version: 5.0-DIRECT-AUTOFILL-FIXED`);
  console.log(`🤖 AI Model: ${MODEL_NAME}`);
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