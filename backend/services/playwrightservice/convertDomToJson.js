function convertToJson(fields) {
    const output = {};
    let skipped = 0;
    let added = 0;

    fields.forEach(f => {
        // Skip invalid names
        if (!f.finalName || f.finalName === "undefined" || f.finalName.startsWith("unknown_")) {
            skipped++;
            return;
        }

        // Skip hidden, button, and submit types
        if (f.type === "hidden" || f.type === "button" || f.type === "submit") {
            skipped++;
            return;
        }

        const fieldData = {
            label: f.label || f.placeholder || "",
            type: f.type
        };

        // Add placeholder if exists
        if (f.placeholder) {
            fieldData.placeholder = f.placeholder;
        }

        // Add options array if it has values
        if (f.options && f.options.length > 0) {
            fieldData.options = f.options;
        }

        output[f.finalName] = fieldData;
        added++;
    });

    console.log(`✓ Converted: ${added} fields added, ${skipped} skipped`);
    
    return output;
}

module.exports = { convertToJson };