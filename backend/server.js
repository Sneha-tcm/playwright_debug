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

// ========================================
// OLLAMA CONFIG (LOCAL DESKTOP)
// ========================================
const API_ENDPOINT = "http://localhost:11435/api/chat";

// Recommended models
const MODEL_NAME = "qwen2.5:3b";
// Alternatives:
// "mistral"
// "qwen2.5:7b"

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
1. Match by semantic meaning, not by similar words.
2. For TEXT fields: provide exact values from the dataset.
3. For FILE UPLOAD fields: generate full document content as text (no file paths).
4. Format dates and phone numbers exactly as required by the form.

5. STRICT DATE-MAPPING RULES:
   - Never mix unrelated dates.
   - **Date of Birth (DOB)** MUST map ONLY to birthdate fields.
   - **Registration / Incorporation / Establishment Date** MUST map ONLY to registration-related fields.
   - **Project Start/End Dates** MUST map ONLY to project timeline fields.
   - **Certificate Issue/Expiry Dates** MUST map ONLY to certificate fields.
   - NEVER swap DOB with registration dates or vice versa.
   - NEVER guess dates. If the correct date is missing, mappedValue = null.

   **DATE FORMAT INTERPRETATION RULES:**
   - If a value is formatted like DD/MM or MM/DD (e.g., "06/07"), treat it as **day + month**, NEVER as a year or year range.
   - If a value appears as DD-MM (e.g., "06-07"), also treat it as **day + month**, not a year.
   - If the value looks like DD/MM/YYYY or DD-MM-YYYY, treat it as a **full date**.
   - If a value contains a hyphen or en-dash between two two-digit numbers representing years (e.g., "25–27", "2020–22", "2019-2021"):
       • Interpret it as a **year span or year range**, NOT a date.
       • Only map to fields explicitly asking for year ranges.
   - If the form requires a full date but the dataset contains only partial information (e.g., only year or only month+year), mappedValue = null.
   - Always output dates in the exact format required by the form field.

6. STRICT NAME-MAPPING RULES:
   - Map the **correct role-specific name**:
     • Organization/NGO/Company Name → ONLY for organization name fields.
     • Authorized Signatory / Point of Contact Name → ONLY for contact or signatory fields.
     • Founder / Director Name → ONLY for founder/director fields.
     • Applicant Name → ONLY for applicant fields.
   - NEVER mix organization names with personal names.
   - NEVER mix different role-based names.
   - If no correct role-specific name exists in the dataset, mappedValue = null.

7.FILEUPLOAD FIELD MAPPING RULES:
 - for fields that require fileupload, search for files in the provided dataset, if the exact files available, map the entire file or documents, if not availabe, then only generate content of the files to be uploaded so that iusers can download the content and upload the same by themselves.For example, if they asked to upload PAN card, then search for a PAN card there, if not available, you cannot generate certificates like PAN so map null, other tan certificates, if they ask for a document containing all the project details, you can always generate one accordingto the size of the respective form field.
7. PAN, registration numbers, and addresses must match exactly (or appropriate portions if required).
8. For project fields, choose the most semantically relevant project.
9. Don't select the same option for dropdowns, after mapping a vaue, if you dont find any other values relevant for next fielsd, instead of duplicating, give mapped value as null reason: no relevant information in dataset.
10. If data is missing, set mappedValue to null and add an entry to missingFields.
11. Include a valid CSS selector for each field (prefer id → name → aria-label).

CRITICAL: Return ONLY the JSON object. No explanations, no markdown, no extra text.`;

// ========================================
// HELPER FUNCTIONS
// ========================================
function analyzeOutputStats(text) {
  if (!text || typeof text !== "string") {
    return { characters: 0, tokens: 0 };
  }

  const characters = text.length;
  const estimatedTokens = Math.ceil(characters / 4);

  return {
    characters,
    estimatedTokens
  };
}

function getLatestDatasetConfig() {
  try {
    const configPath = path.join(__dirname, "dataset-configs", "dataset-config.json");
    
    if (!fs.existsSync(configPath)) {
      console.warn("⚠️ No dataset configuration found at:", configPath);
      return null;
    }

    const configData = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configData);
    
    console.log("📦 Loaded dataset config:");
    console.log("  Type:", config.type);
    console.log("  Last Saved:", config.lastSaved);
    
    // 🔍 NEW: Validate and extract actual data
    let actualData = null;
    
    if (config.type === "local") {
      if (config.local?.processedData) {
        actualData = config.local.processedData;
        console.log("  ✅ Has processedData with keys:", Object.keys(actualData));
      } else {
        console.warn("  ⚠️ No processedData found in local config!");
        
        // Try to load from processed-data folder as fallback
        const processedDataPath = path.join(__dirname, "processed-data");
        if (fs.existsSync(processedDataPath)) {
          const files = fs.readdirSync(processedDataPath)
            .filter(f => f.startsWith("processed-data-") && f.endsWith(".json"))
            .sort()
            .reverse();
          
          if (files.length > 0) {
            const latestFile = files[0];
            const data = JSON.parse(fs.readFileSync(path.join(processedDataPath, latestFile), "utf-8"));
            actualData = data;
            console.log("  ✅ Loaded from fallback file:", latestFile);
          }
        }
      }
    }
    
    // Return the processed data directly, not the config wrapper
    return actualData || config;
    
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
// AI MAPPING FUNCTION - ENHANCED WITH DEBUG
// ========================================
async function performAIMapping(formSchema, datasetConfig) {
  console.log("\n🤖 Starting AI Mapping with Ollama (Local)...");

  try {
    // 🔍 DEBUG SECTION
    console.log("\n📊 DEBUG: Dataset Config Structure:");
    console.log("Type:", datasetConfig?.type);
    console.log("Has local data:", !!datasetConfig?.local);
    console.log("Has processedData:", !!datasetConfig?.local?.processedData);
    
    // Log the actual data structure
    if (datasetConfig?.local?.processedData) {
      console.log("\n✅ ProcessedData Keys:", Object.keys(datasetConfig.local.processedData));
      console.log("Sample Data:", JSON.stringify(datasetConfig.local.processedData, null, 2).substring(0, 500) + "...");
    } else if (datasetConfig && !datasetConfig.type) {
      // Data was passed directly without wrapper
      console.log("\n✅ Direct Data Keys:", Object.keys(datasetConfig));
      console.log("Sample Data:", JSON.stringify(datasetConfig, null, 2).substring(0, 500) + "...");
    } else {
      console.log("\n❌ WARNING: No processedData found!");
      console.log("Full config:", JSON.stringify(datasetConfig, null, 2).substring(0, 300));
    }
    
    // Extract the actual data to send to AI
    let actualDataset = datasetConfig;
    
    // If processedData exists, use that instead of the config wrapper
    if (datasetConfig?.local?.processedData) {
      actualDataset = datasetConfig.local.processedData;
      console.log("\n✅ Using processedData directly");
    } else if (datasetConfig?.type) {
      console.warn("\n⚠️ Config wrapper detected but no processedData - this may cause empty mappings!");
    }

    const promptText = `${AI_MAPPING_PROMPT}

FORM FIELDS:
${JSON.stringify(formSchema.fields || formSchema, null, 2)}

DATASET:
${JSON.stringify(actualDataset, null, 2)}

IMPORTANT: Your response must be ONLY a valid JSON object starting with { and ending with }.
`;

    console.log("📤 Sending request to Ollama...");
    console.log("📏 Prompt length:", promptText.length);
    console.log("📏 Dataset length:", JSON.stringify(actualDataset).length);

    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.9
        },
        messages: [
          {
            role: "system",
            content: "You are a strict JSON-only AI mapping engine. You must analyze the provided dataset and map form fields to the available data."
          },
          {
            role: "user",
            content: promptText
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Ollama API Error:", errorText);
      throw new Error(`Ollama Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const textOutput = data?.message?.content;
    
    if (!textOutput) throw new Error("Ollama returned no content.");

    console.log("📥 Raw Ollama Response (first 500 chars):", textOutput.substring(0, 500));

    const metrics = analyzeOutputStats(textOutput);
    console.log("📏 Output Characters:", metrics.characters);
    console.log("🔢 Estimated Tokens:", metrics.estimatedTokens);

    // 🧹 Strict JSON extraction
    let cleanText = textOutput.trim();
    const first = cleanText.indexOf("{");
    const last = cleanText.lastIndexOf("}");

    if (first === -1 || last === -1) {
      throw new Error("No valid JSON object found in Ollama response");
    }

    cleanText = cleanText.substring(first, last + 1);
    const parsedResult = JSON.parse(cleanText);
    
    // 🔍 Validate the result
    console.log("\n📋 Mapping Result Summary:");
    console.log("  Mapped fields:", parsedResult.mappedFields?.length || 0);
    console.log("  Missing fields:", parsedResult.missingFields?.length || 0);
    console.log("  Fields with values:", parsedResult.mappedFields?.filter(f => f.mappedValue !== null).length || 0);
    
    return parsedResult;

  } catch (err) {
    console.error("❌ Ollama Mapping Error:", err.message);
    return { error: err.message, mappedFields: [], missingFields: [] };
  }
}

async function performChunkedMapping(formSchema, datasetConfig) {
  console.log("📄 Running Chunked AI Mapping...");

  const chunks = chunkFields(formSchema.fields, 5);

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
      const originalField = formFields[field.fieldId];
      
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
      console.log("📄 Using chunked mapping for large form...");
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
        type: datasetConfig.type || "direct",
        lastSaved: datasetConfig.lastSaved,
        hasData: !!(datasetConfig.profile || datasetConfig.organization || datasetConfig.local?.processedData)
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
// SAVE PROCESSED DATA
// ========================================
async function saveProcessedData(processedData) {
  try {
    const dataDir = path.join(__dirname, "processed-data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const timestamp = new Date(processedData.processedAt || new Date())
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
// TEST DATASET ENDPOINT
// ========================================
app.get("/api/dataset/test", async (req, res) => {
  try {
    console.log("\n🧪 Testing Dataset Configuration...\n");
    
    const configPath = path.join(__dirname, "dataset-configs", "dataset-config.json");
    const configExists = fs.existsSync(configPath);
    console.log("1. Config file exists:", configExists);
    
    if (!configExists) {
      return res.json({
        success: false,
        error: "No dataset configuration file found",
        hint: "Upload your dataset first using POST /api/dataset/configure"
      });
    }
    
    const configData = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configData);
    console.log("2. Config type:", config.type);
    console.log("3. Config keys:", Object.keys(config));
    
    let dataAnalysis = {
      hasLocalData: !!config.local,
      hasProcessedData: !!config.local?.processedData,
      processedDataKeys: config.local?.processedData ? Object.keys(config.local.processedData) : [],
      sampleData: null
    };
    
    if (config.local?.processedData) {
      const data = config.local.processedData;
      
      dataAnalysis.hasProfile = !!data.profile;
      dataAnalysis.hasOrganization = !!data.organization;
      dataAnalysis.hasProjects = !!data.projects;
      dataAnalysis.hasFinancials = !!data.financials;
      
      if (data.profile) {
        dataAnalysis.sampleData = {
          profile: data.profile
        };
      } else if (data.organization) {
        dataAnalysis.sampleData = {
          organization: data.organization
        };
      }
    }
    
    console.log("4. Data analysis:", JSON.stringify(dataAnalysis, null, 2));
    
    const processedDataPath = path.join(__dirname, "processed-data");
    const processedDataExists = fs.existsSync(processedDataPath);
    let processedFiles = [];
    
    if (processedDataExists) {
      processedFiles = fs.readdirSync(processedDataPath)
        .filter(f => f.endsWith(".json"));
    }
    
    console.log("5. Processed data folder exists:", processedDataExists);
    console.log("6. Processed files count:", processedFiles.length);
    
    const recommendations = [];
    
    if (!dataAnalysis.hasProcessedData) {
      recommendations.push("❌ No processedData found - ensure your extension is sending the processed data correctly");
    }
    
    if (dataAnalysis.processedDataKeys.length === 0) {
      recommendations.push("❌ ProcessedData is empty - check your file upload and processing logic");
    }
    
    if (!dataAnalysis.hasProfile && !dataAnalysis.hasOrganization) {
      recommendations.push("⚠️ No profile or organization data - the AI won't be able to map personal/company fields");
    }
    
    if (recommendations.length === 0) {
      recommendations.push("✅ Dataset looks good! Ready for AI mapping");
    }
    
    res.json({
      success: true,
      tests: {
        configExists,
        configType: config.type,
        dataStructure: dataAnalysis,
        processedDataFolder: {
          exists: processedDataExists,
          filesCount: processedFiles.length,
          latestFile: processedFiles[0] || null
        }
      },
      config: config,
      recommendations: recommendations
    });
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// ========================================
// DATASET CONFIGURATION ENDPOINT - ENHANCED
// ========================================
app.post("/api/dataset/configure", async (req, res) => {
  try {
    const config = req.body;

    console.log("\n📦 Dataset Configuration Received:");
    console.log("Type:", config.type);

    if (config.type === "local") {
      console.log(`Local Files: ${config.local?.totalFiles || 0} files`);

      if (config.local?.processedData) {
        console.log("\n📊 Processed Data Received:");
        console.log(`  - Total files: ${config.local.processedData.totalFiles || 0}`);
        console.log(`  - Successfully processed: ${config.local.processedData.successCount || 0}`);
        console.log(`  - Failed: ${config.local.processedData.errorCount || 0}`);
        
        const dataKeys = Object.keys(config.local.processedData);
        console.log(`  - Data sections: ${dataKeys.join(", ")}`);
        
        const hasProfile = !!config.local.processedData.profile;
        const hasOrganization = !!config.local.processedData.organization;
        console.log(`  - Has profile data: ${hasProfile}`);
        console.log(`  - Has organization data: ${hasOrganization}`);
        
        if (!hasProfile && !hasOrganization) {
          console.warn("  ⚠️ WARNING: No profile or organization data found!");
        }

        await saveProcessedData(config.local.processedData);
      } else {
        console.warn("  ⚠️ WARNING: No processedData in config!");
        console.log("  Config structure:", JSON.stringify(config, null, 2).substring(0, 300));
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
          ? `${config.local?.totalFiles || 0} local files${config.local?.processedData ? " (processed)" : ""}`
          : `Google Drive ${config.drive?.type}`,
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
// DIRECT AUTOFILL ENDPOINT - ENHANCED
// ========================================
app.post("/api/autofill/direct", async (req, res) => {
  try {
    const { url, dataset } = req.body;

    console.log("\n🤖 Direct Autofill Request");
    console.log("URL:", url);
    console.log("Dataset provided:", !!dataset);

    let datasetConfig = dataset || getLatestDatasetConfig();
    
    if (!datasetConfig) {
      return res.status(400).json({
        success: false,
        error: "No dataset configuration found"
      });
    }

    let formSchema;
    const formSchemaPath = path.join(__dirname, "contact-form-schema.json");
    
    if (fs.existsSync(formSchemaPath)) {
      const existingSchema = JSON.parse(fs.readFileSync(formSchemaPath, "utf-8"));
      
      if (existingSchema.url === url) {
        console.log("✅ Using cached form schema");
        formSchema = existingSchema;
      }
    }

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
        
        fs.writeFileSync(formSchemaPath, JSON.stringify(formSchema, null, 2));
        console.log("✅ Form schema saved");
      } finally {
        if (page) {
          console.log("🔌 Closing Playwright context");
          await page.context().close();
        }
      }
    }

    console.log("🤖 Running AI mapping...");
    
    const fieldCount = Object.keys(formSchema.fields).length;
    console.log(`📋 Total fields to map: ${fieldCount}`);
    
    let aiResult;
    if (fieldCount > 10) {
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

    const autofillCommands = transformToAutofillCommands(
      aiResult.mappedFields, 
      formSchema.fields
    );

    console.log(`✅ Generated ${autofillCommands.length} autofill commands`);

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
    
    const fieldCount = Object.keys(result.fields).length;
    console.log(`📋 Form has ${fieldCount} fields`);
    
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

// ========================================
// HEALTH CHECK
// ========================================
app.get("/", (req, res) => {
  res.json({
    message: "AI Autofill Backend is running!",
    version: "6.0-ENHANCED-DEBUG",
    aiProvider: "Ollama Local",
    model: MODEL_NAME,
    endpoints: {
      "POST /api/autofill/direct": "Get autofill commands for URL",
      "POST /api/dataset/configure": "Configure dataset",
      "GET  /api/dataset/test": "Test dataset configuration",
      "POST /scan-form": "Scan form structure",
      "GET  /api/ai-mapping/latest": "Get latest mapping",
      "GET  /api/dataset/processed-data": "Get processed data"
    },
  });
});

// ========================================
// START SERVER
// ========================================
const server = app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 AI Autofill Backend Server - Enhanced Debug Mode`);
  console.log(`${"=".repeat(60)}`);
  console.log(`🌐 Running on: http://localhost:${PORT}`);
  console.log(`📊 Version: 6.0-ENHANCED-DEBUG`);
  console.log(`🤖 AI Model: ${MODEL_NAME}`);
  console.log(`\n🆕 New Features:`);
  console.log(`   - Enhanced dataset debugging`);
  console.log(`   - Dataset validation endpoint: GET /api/dataset/test`);
  console.log(`   - Improved error logging`);
  console.log(`${"=".repeat(60)}\n`);
});

process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});