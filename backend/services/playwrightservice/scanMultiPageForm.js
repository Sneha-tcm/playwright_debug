const { extractDom } = require('./extractDom');
const { detectField } = require('./detectField');
const { convertToJson } = require('./convertDomToJson');

async function scanMultiPageForm(page, config) {
    const allPages = [];
    let currentPage = 1;
    let hasNextPage = true;

    try {
        while (hasNextPage && currentPage <= config.maxPages) {
            console.log(`\n📄 Scanning Page ${currentPage}...`);
            
            // Wait for page to stabilize
            await page.waitForTimeout(2000);
            
            // Extract everything from current page
            const extractedData = await extractDom(page);
            const domFields = extractedData.fields || [];
            const buttons = extractedData.buttons || [];
            const stepIndicators = extractedData.stepIndicators || [];

            // Process fields
            const detected = detectField(domFields);
            const pageFields = convertToJson(detected);

            // Find Next button
            const nextButton = buttons.find(btn => 
                btn.purpose === "next" && 
                btn.isVisible && 
                !btn.isDisabled
            );

            // Get page info
            const currentUrl = page.url();
            const pageTitle = await page.title();

            allPages.push({
                pageNumber: currentPage,
                url: currentUrl,
                title: pageTitle,
                fieldCount: pageFields.length,
                fields: pageFields,
                buttons: buttons,
                stepIndicators: stepIndicators,
                hasNextButton: !!nextButton
            });

            console.log(`✓ Page ${currentPage}:`);
            console.log(`  Title: ${pageTitle}`);
            console.log(`  Fields: ${pageFields.length}`);
            console.log(`  Buttons: ${buttons.length}`);
            if (nextButton) {
                console.log(`  Next Button: "${nextButton.text}"`);
            }

            // Try to go to next page
            if (nextButton) {
                console.log(`\n🔘 Clicking Next button: "${nextButton.text}"`);
                
                try {
                    // Build selector for the button
                    let buttonSelector;
                    if (nextButton.id) {
                        buttonSelector = `#${nextButton.id}`;
                    } else if (nextButton.text) {
                        buttonSelector = `button:has-text("${nextButton.text}"), input[value="${nextButton.text}"]`;
                    } else {
                        buttonSelector = config.nextButtonSelector;
                    }

                    console.log(`  Using selector: ${buttonSelector}`);

                    // Click and wait for navigation
                    await Promise.all([
                        page.waitForNavigation({ 
                            waitUntil: 'domcontentloaded', 
                            timeout: 30000 
                        }).catch((err) => {
                            console.log('  No navigation occurred or timeout');
                            return null;
                        }),
                        page.click(buttonSelector).catch((err) => {
                            console.log(`  Click failed: ${err.message}`);
                            throw err;
                        })
                    ]);

                    // Check if we actually moved to a new page
                    const newUrl = page.url();
                    if (newUrl === currentUrl) {
                        console.log('  ⚠️ URL did not change - might be same-page form');
                        // Wait for DOM changes instead
                        await page.waitForTimeout(1000);
                    }

                    currentPage++;
                    
                } catch (clickError) {
                    console.log(`  ⚠️ Could not navigate: ${clickError.message}`);
                    hasNextPage = false;
                }
            } else {
                console.log(`\n✅ No Next button found - End of form`);
                hasNextPage = false;
            }
        }

        if (currentPage > config.maxPages) {
            console.log(`\n⚠️ Reached maximum page limit (${config.maxPages})`);
        }

        return allPages;

    } catch (error) {
        console.error(`\n❌ Error on page ${currentPage}:`, error.message);
        // Return what we've collected so far
        return allPages;
    }
}

module.exports = { scanMultiPageForm };