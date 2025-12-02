function detectField(fields) {
    console.log(`Processing ${fields.length} fields...`);
    
    return fields.map(f => {
        let label = f.label;

        // Fallback priority for labels
        if (!label && f._headingLabel) label = f._headingLabel;
        if (!label && f._gfLabel) label = f._gfLabel;
        if (!label && f._parentLabel) label = f._parentLabel;
        if (!label && f._prevLabel) label = f._prevLabel;
        if (!label && f._nearText) label = f._nearText;
        if (!label && f.placeholder) label = f.placeholder;
        if (!label && f.name) {
            label = f.name.replace(/_/g, " ").replace(/\[|\]/g, "").replace(/\b\w/g, c => c.toUpperCase());
        }
        if (!label && f.id) {
            label = f.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        }

        // Create finalName with priority: name > id > label-based
        let finalName = f.name || f.id;
        
        if (!finalName && label) {
            finalName = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        }
        
        if (!finalName) {
            finalName = "unknown_" + Math.random().toString(36).substr(2, 6);
        }

        // Return with options preserved
        return {
            finalName,
            label: label || "",
            placeholder: f.placeholder || "",
            tag: f.tag,
            type: f.type,
            options: f.options || []  // CRITICAL: Keep options!
        };
    });
}

module.exports = { detectField };