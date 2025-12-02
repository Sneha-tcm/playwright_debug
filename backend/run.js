const { loadPage } = require('./services/playwrightservice/loadPage');
const { extractDom } = require('./services/playwrightservice/extractDom');
const { detectField } = require('./services/playwrightservice/detectField');
const { convertToJson } = require('./services/playwrightservice/convertDomToJson');
const fs = require('fs');

(async () => {
    const url = "https://atalfoundation.ind.in/online-application/";

    try {
        console.log("Extracting contact form...\n");
        
        const page = await loadPage(url);
        const domFields = await extractDom(page);
        
        console.log(`✓ Extracted ${domFields.length} DOM elements\n`);
        
        // Check for fields with options
        const withOptions = domFields.filter(f => f.options && f.options.length > 0);
        console.log(`Found ${withOptions.length} fields with options:\n`);
        withOptions.forEach(f => {
            console.log(`  ${f.name}: ${f.options.join(', ')}`);
        });
        
        const detected = detectField(domFields);
        const finalJson = convertToJson(detected);

        console.log("\n=== FINAL JSON ===\n");
        console.log(JSON.stringify(finalJson, null, 2));
        
        fs.writeFileSync('contact-form-schema.json', JSON.stringify(finalJson, null, 2));
        console.log("\n✓ Saved to contact-form-schema.json");

        await page.context().browser().close();
        
    } catch (err) {
        console.error("Error:", err);
        console.error(err.stack);
        process.exit(1);
    }
})();