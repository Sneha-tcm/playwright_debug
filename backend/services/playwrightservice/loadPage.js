const { chromium } = require("playwright");

async function loadPage(url) {
    console.log(`🌐 Loading page: ${url}`);
    
    const browser = await chromium.launch({ 
        headless: false,
        timeout: 60000 // Increase browser launch timeout
    });
    
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });
    
    const page = await context.newPage();
    
    // Try multiple strategies for loading
    try {
        // First try with networkidle (waits for network to be quiet)
        await page.goto(url, { 
            waitUntil: 'networkidle',
            timeout: 60000  // 60 seconds
        });
        console.log(`✅ Page loaded with networkidle`);
    } catch (error) {
        console.log('⚠️ Networkidle timeout, trying with load event...');
        try {
            // Fallback: just wait for load event
            await page.goto(url, { 
                waitUntil: 'load',
                timeout: 60000
            });
            console.log(`✅ Page loaded with load event`);
        } catch (error2) {
            console.log('⚠️ Load timeout, trying with domcontentloaded...');
            // Last fallback: original method
            await page.goto(url, { 
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            console.log(`✅ Page loaded with domcontentloaded`);
        }
    }
    
    // Wait a bit more for any dynamic content to load
    await page.waitForTimeout(2000);
    
    console.log(`✅ Page ready for extraction`);
    
    return page;
}

module.exports = { loadPage };