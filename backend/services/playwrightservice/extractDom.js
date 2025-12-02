async function extractDom(page) {
    console.log("Extracting DOM fields...");
    
    return await page.evaluate(() => {
        const fields = [];
        const buttons = [];

        // Extract form fields
        document.querySelectorAll("input, select, textarea").forEach(el => {
            const id = el.id || "";
            const name = el.name || "";
            const placeholder = el.placeholder || "";
            const type = el.type || "";
            const tag = el.tagName.toLowerCase();

            // Get labels - multiple methods
            let directLabel = id ? document.querySelector(`label[for='${id}']`)?.innerText?.trim() : "";
            let parentLabel = el.closest("label")?.innerText?.trim() || "";
            let prevLabel = el.previousElementSibling?.tagName === "LABEL" ? el.previousElementSibling.innerText.trim() : "";
            let nearText = el.parentElement?.querySelector("label")?.innerText?.trim() || "";
            let gfLabel = el.closest(".gfield")?.querySelector(".gfield_label")?.innerText?.trim() || "";
            
            let headingLabel = "";
            const parentFieldset = el.closest("fieldset");
            if (parentFieldset) {
                const legend = parentFieldset.querySelector("legend");
                headingLabel = legend ? legend.innerText.trim() : "";
            }

            let options = [];
            
            // For SELECT dropdowns
            if (tag === "select") {
                options = [...el.querySelectorAll("option")]
                    .map(opt => opt.innerText.trim())
                    .filter(text => {
                        if (!text) return false;
                        const lower = text.toLowerCase();
                        return lower !== "select" && 
                               lower !== "select job" && 
                               lower !== "choose" &&
                               lower !== "---" &&
                               lower !== "select category" &&
                               text !== "";
                    });
            }

            // For CHECKBOX - find all checkboxes with same name
            if (type === "checkbox") {
                const allCheckboxes = document.querySelectorAll(`input[name="${name}"]`);
                
                if (allCheckboxes.length > 1) {
                    const checkboxOptions = [...allCheckboxes].map(cb => {
                        let cbLabel = cb.id ? document.querySelector(`label[for="${cb.id}"]`)?.innerText?.trim() : "";
                        if (!cbLabel) cbLabel = cb.closest("label")?.innerText?.trim() || "";
                        if (!cbLabel) {
                            const nextLabel = cb.nextElementSibling;
                            if (nextLabel && nextLabel.tagName === "LABEL") {
                                cbLabel = nextLabel.innerText.trim();
                            }
                        }
                        return cbLabel;
                    }).filter(Boolean);
                    
                    if (checkboxOptions.length > 0) {
                        options = [...new Set(checkboxOptions)];
                    }
                }
                
                if (options.length === 0) {
                    const gfield = el.closest(".gfield");
                    if (gfield) {
                        const gchoices = [...gfield.querySelectorAll(".gchoice")];
                        if (gchoices.length > 0) {
                            const checkboxLabels = gchoices.map(choice => {
                                const label = choice.querySelector("label");
                                return label ? label.innerText.trim() : "";
                            }).filter(Boolean);
                            
                            if (checkboxLabels.length > 0) {
                                options = checkboxLabels;
                            }
                        }
                    }
                }
            }

            // For RADIO buttons
            if (type === "radio") {
                const allRadios = document.querySelectorAll(`input[name="${name}"]`);
                const radioLabels = [...allRadios].map(radio => {
                    let radioLabel = radio.id ? document.querySelector(`label[for="${radio.id}"]`)?.innerText?.trim() : "";
                    if (!radioLabel) radioLabel = radio.closest("label")?.innerText?.trim() || "";
                    return radioLabel;
                }).filter(Boolean);
                
                if (radioLabels.length > 0) {
                    options = [...new Set(radioLabels)];
                }
            }

            fields.push({
                tag,
                type,
                id,
                name,
                placeholder,
                label: directLabel,
                _parentLabel: parentLabel,
                _prevLabel: prevLabel,
                _nearText: nearText,
                _gfLabel: gfLabel,
                _headingLabel: headingLabel,
                options: options
            });
        });

        // Extract ALL buttons (Next, Cancel, Submit, Previous, etc.)
        document.querySelectorAll("button, input[type='submit'], input[type='button']").forEach(btn => {
            const id = btn.id || "";
            const name = btn.name || "";
            const value = btn.value || "";
            const type = btn.type || "";
            const text = btn.textContent?.trim() || value;
            const className = btn.className || "";
            
            // Determine button purpose based on text
            const textLower = text.toLowerCase();
            let purpose = "unknown";
            
            if (textLower.includes("next") || textLower.includes("continue") || textLower.includes("proceed")) {
                purpose = "next";
            } else if (textLower.includes("previous") || textLower.includes("back")) {
                purpose = "previous";
            } else if (textLower.includes("submit") || type === "submit") {
                purpose = "submit";
            } else if (textLower.includes("cancel") || textLower.includes("close")) {
                purpose = "cancel";
            } else if (textLower.includes("skip")) {
                purpose = "skip";
            }

            // Check visibility and enabled state
            const isVisible = btn.offsetParent !== null;
            const isDisabled = btn.disabled;

            buttons.push({
                type: "button",
                buttonType: type,
                purpose: purpose,
                id: id,
                name: name,
                value: value,
                text: text,
                className: className,
                isVisible: isVisible,
                isDisabled: isDisabled
            });
        });

        // Get step indicators or page info
        const stepIndicators = [];
        document.querySelectorAll(".step, .steps, .step-indicator, [class*='step'], .progress-step, .wizard-step, [class*='page']").forEach(step => {
            const text = step.textContent?.trim() || "";
            if (text) {
                stepIndicators.push({
                    text: text,
                    className: step.className,
                    isActive: step.classList.contains("active") || 
                             step.classList.contains("current") ||
                             step.getAttribute("aria-current") === "true"
                });
            }
        });

        return {
            fields: fields,
            buttons: buttons,
            stepIndicators: stepIndicators
        };
    });
}

module.exports = { extractDom };