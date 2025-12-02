const fetch = require('node-fetch');

const prompt = `You are an AI Field-Mapping Engine tasked with generating content for form fields based on an organization dataset.
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
Important: Never return anything outside this JSON structure.
`;

async function AI_Mapping(promptText, FormSchema, DatasetSchema) {
  const OLLAMA_API_KEY = "7f45a572cf934e9e8628ddbb0270ace4.dgCQnMABb_97Im-lX-O75RF3"; // ⚠ Only for personal use
  
  try {
    // Prepare the full prompt with form fields and dataset
    const fullPrompt = `${promptText}

FORM FIELDS:
${JSON.stringify(FormSchema, null, 2)}

DATASET:
${JSON.stringify(DatasetSchema, null, 2)}

Please map the form fields to the dataset and return ONLY valid JSON with mappedFields and missingFields.`;

    console.log("\n🤖 AI_Mapping called");
    console.log("   Sending request to API...");

    // ✅ FIXED: Correct API endpoint
    const response = await fetch("https://ollama.com/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [
          { role: "system", content: "You are an AI assistant that maps form fields to dataset values. Always respond with valid JSON only." },
          { role: "user", content: fullPrompt }
        ],
        stream: false,
        temperature: 0.3,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("   ❌ API Error:", response.status, errorText);
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // ✅ FIXED: Correct response format (OpenAI-compatible)
    const aiMessage = data.choices?.[0]?.message?.content;
    
    if (!aiMessage) {
      console.error("   ❌ No content in response");
      throw new Error("No AI response content");
    }

    console.log("   ✅ AI Response received");
    console.log("AI Message:", aiMessage.substring(0, 200) + "...");
    
    return aiMessage;
    
  } catch (err) {
    console.error("   ❌ AI_Mapping Error:", err.message);
    console.error(err);
    return null;
  }
}

module.exports = {
  AI_Mapping,
  prompt
};