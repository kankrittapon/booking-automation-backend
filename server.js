// server.js
const express = require('express');
const { chromium, firefox, webkit } = require('playwright');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// เพิ่ม Map สำหรับแก้ไขข้อความสาขาที่แตกต่างกันระหว่าง React App กับเว็บไซต์เป้าหมาย
// ใช้เมื่อค่า config.branch ที่ส่งมาจาก React (ซึ่งเป็นข้อความแสดงผล)
// ไม่ตรงกับข้อความบนปุ่มในเว็บไซต์เป้าหมายเป๊ะๆ (เช่น เว้นวรรค, ตัวพิมพ์ใหญ่-เล็ก)
const branchTextCorrectionMap = {
    "Central World": "Centralworld", // ถ้า React ส่ง "Central World", ให้ไปคลิกปุ่มที่มีข้อความ "Centralworld" (คำเดียว)
    "ICON SIAM": "Icon Siam",       // ถ้า React ส่ง "ICON SIAM", ให้ไปคลิกปุ่มที่มีข้อความ "Icon Siam"
    "Emphere": "Emsphere",
	"Terminal 21":"Terminal 21",
	"Centralworld":"Centralworld",
	"Central Ladprao":"Central Ladprao",
	"Fashion Island":"Fashion Island",
	"MEGABANGNA":"MEGABANGNA",
	"Siam Center":"Siam Center",
	"Siam Square":"Siam Square",
	"Central Pattaya":"Central Pattaya",
	"Seacon Square":"Seacon Square",
	"Central Westgate":"Central Westgate",
	"Central Chiangmai":"Central Chiangmai"
	// ถ้า React ส่ง "Emphere", ให้ไปคลิกปุ่มที่มีข้อความ "Emsphere"
    // เพิ่มคู่ที่ต้องแก้ไขอื่นๆ หากพบความไม่ตรงกันอีก
};

// Map สำหรับเก็บข้อมูล Browser Context และ Page ของแต่ละ Process ที่กำลังทำงาน
// Key: processId (string), Value: { browserContext: BrowserContext, page: Page }
const activeProcesses = new Map();


// --- ฟังก์ชันสำหรับ Login LINE ---
async function performLineLogin(page, email, password, processId) {
    console.log(`Process ${processId}: Checking LINE connection status...`);

    const connectButtonOnBookingAppSelector = 'button.sc-48e8cede-5:has-text("Connect")';
    const connectLineAccountButtonSelector = 'button.sc-48e8cede-5:has-text("Connect LINE Account*")';

    const isConnectButtonVisible = await page.isVisible(connectButtonOnBookingAppSelector, { timeout: 5000 }).catch(() => false);

    if (isConnectButtonVisible) {
        console.log(`Process ${processId}: "Connect" button found on booking app. Clicking...`);
        await page.click(connectButtonOnBookingAppSelector);

        console.log(`Process ${processId}: Waiting for "Connect LINE Account*" button...`);
        await page.waitForSelector(connectLineAccountButtonSelector, { state: 'visible', timeout: 10000 });
        console.log(`Process ${processId}: Clicking "Connect LINE Account*" button...`);
        await page.click(connectLineAccountButtonSelector);

        console.log(`Process ${processId}: Waiting for LINE login page (access.line.me)...`);
        await page.waitForURL('https://access.line.me/oauth2/v2.1/login*', { timeout: 30000 });

        console.log(`Process ${processId}: Filling LINE email...`);
        await page.fill('input[name="tid"][placeholder="Email address"]', email);
        
        console.log(`Process ${processId}: Filling LINE password...`);
        await page.fill('input[name="tpasswd"][placeholder="Password"]', password);

        console.log(`Process ${processId}: Clicking LINE login button...`);
        await page.click('button.MdBtn01[type="submit"]:has-text("Log in")');

        console.log(`Process ${processId}: Waiting for LINE mobile confirmation and redirect back to booking app.`);
        console.log(`Process ${processId}: >>> PLEASE CONFIRM ON YOUR MOBILE DEVICE IF REQUIRED BY LINE. <<<`);
        await page.waitForURL('https://popmartth.rocket-booking.app/**', { timeout: 120000 });
        console.log(`Process ${processId}: Redirected back to booking app after LINE login.`);

    } else {
        console.log(`Process ${processId}: "Connect" button not found. Assuming LINE account is already connected.`);
    }
}

// --- ฟังก์ชันใหม่สำหรับจัดการ CAPTCHA ที่ปรากฏแบบสุ่ม ---
async function handleRandomCaptcha(page, processId, isTestMode) {
    // Selector สำหรับ CAPTCHA ที่อิงตามข้อความและปุ่มที่คุณให้มา
    const captchaSelectors = [
        'text="Let\'s confirm you are human"', // หัวข้อหลัก
        'text="Choose all the beds"', // คำสั่งสำหรับเตียง
        'text="Choose all the curtains"', // คำสั่งสำหรับผ้าม่าน
        'button:has-text("Confirm")', // ปุ่ม Confirm ของ CAPTCHA
        'iframe[title="reCAPTCHA challenge expired"]', // reCAPTCHA iframe ทั่วไป
        'div.g-recaptcha', // reCAPTCHA div ทั่วไป
        'div[data-sitekey]', // reCAPTCHA div ทั่วไป
    ];

    let captchaDetected = false;
    for (const selector of captchaSelectors) {
        // ตรวจสอบว่า Selector นั้นมองเห็นได้หรือไม่
        const isVisible = await page.isVisible(selector, { timeout: 1000 }).catch(() => false);
        if (isVisible) {
            captchaDetected = true;
            console.log(`Process ${processId}: !!! CAPTCHA DETECTED at selector: '${selector}' !!!`);
            console.log(`Process ${processId}: >>> PLEASE SOLVE CAPTCHA MANUALLY IN THE BROWSER WINDOW. <<<`);
            
            const captchaSolveTimeout = isTestMode ? 10000 : 300000; // 10s for test, 5 mins for real
            try {
                // รอให้ CAPTCHA element หายไป (hidden หรือ detached)
                // หรือรอให้ปุ่ม Confirm ของ CAPTCHA ถูกคลิกและหายไป
                await page.waitForSelector(selector, { state: 'hidden', timeout: captchaSolveTimeout });
                console.log(`Process ${processId}: CAPTCHA at '${selector}' appears to be solved.`);
                return true; // CAPTCHA ถูกตรวจพบและรอการแก้ไข
            } catch (e) {
                console.error(`Process ${processId}: Timeout waiting for CAPTCHA at '${selector}' to disappear. It might still be visible or a new one appeared. Error: ${e.message}`);
                throw new Error(`CAPTCHA not solved within timeout for process ${processId}. Manual intervention required.`);
            }
        }
    }
    return captchaDetected; // คืนค่า true ถ้าตรวจพบและรอ CAPTCHA, false ถ้าไม่พบ
}
// --- สิ้นสุดฟังก์ชันจัดการ CAPTCHA ---


// API Endpoint สำหรับรับคำสั่งเริ่ม Booking Automation
app.post('/start-booking-process', async (req, res) => {
    const { processId, browserType, config } = req.body;
    const { branch, date, time, lineEmail, linePassword, isTestMode, testSiteUrl, targetBookingTime } = config;
    console.log(`Received request to start process: ${processId} on ${browserType} with config:`, config);

    if (activeProcesses.has(processId)) {
        return res.status(400).json({ status: 'error', message: `Process ID '${processId}' is already running.` });
    }

    let browserContext;
    let page;

    try {
        let browserLaunchOptions = {
            headless: false, // เพื่อให้เห็นหน้าต่าง Browser
            slowMo: 100,     // เพิ่มการหน่วงเวลา 100ms ระหว่างการกระทำแต่ละครั้ง เพื่อให้ดูเป็นธรรมชาติ
            args: [          // Argument สำหรับหลีกเลี่ยงการตรวจจับ Bot
                '--disable-blink-features=AutomationControlled',
                '--disable-extensions',
                '--no-sandbox', // อาจจำเป็นสำหรับบางสภาพแวดล้อม
                '--disable-setuid-sandbox' // อาจจำเป็นสำหรับบางสภาพแวดล้อม
            ],
            viewport: { width: 1280, height: 720 }, // กำหนดขนาด viewport ที่มาตรฐาน
        };

        const userDataDir = path.join(__dirname, 'user_data', processId + '_' + browserType);

        if (browserType === 'chrome') {
            browserContext = await chromium.launchPersistentContext(userDataDir, { ...browserLaunchOptions, channel: 'chrome' });
        } else if (browserType === 'msedge') {
            browserContext = await chromium.launchPersistentContext(userDataDir, { ...browserLaunchOptions, channel: 'msedge' });
        } else if (browserType === 'firefox') {
            browserContext = await firefox.launchPersistentContext(userDataDir, { ...browserLaunchOptions });
        } else if (browserType === 'webkit') {
            browserContext = await webkit.launchPersistentContext(userDataDir, { ...browserLaunchOptions });
        } else {
            return res.status(400).json({ status: 'error', message: 'Invalid browser type' });
        }

        page = await browserContext.newPage();
        activeProcesses.set(processId, { browserContext, page });
        console.log(`Process ${processId} started and stored.`);

        const targetBookingUrl = isTestMode ? testSiteUrl : 'https://popmartth.rocket-booking.app/';
        console.log(`Process ${processId}: Navigating to target URL: ${targetBookingUrl} (Test Mode: ${isTestMode})`);
        await page.goto(targetBookingUrl, { waitUntil: 'networkidle' });


        // --- ขั้นตอนการ Login LINE (เฉพาะ Real Mode หรือถ้า Test Site ต้องการ) ---
        // ตรวจสอบว่ามี Email/Password LINE มาให้หรือไม่ก่อนพยายาม Login
        // และถ้าเป็น Test Mode จะไม่บังคับให้ Login
        if (lineEmail && linePassword && !isTestMode) { // Changed condition for LINE login
            await performLineLogin(page, lineEmail, linePassword, processId);
        } else if (isTestMode) {
            console.log(`Process ${processId}: Skipping LINE login in Test Mode.`);
        } else {
            console.log(`Process ${processId}: LINE credentials not provided. Skipping LINE login.`);
        }
        // --- สิ้นสุดขั้นตอนการ Login LINE ---


        // --- โค้ดสำหรับการทำ Booking Automation ---

        // 1. รอให้ปุ่ม "Register" ปรากฏและคลิก
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const registerButtonSelector = 'button:has-text("Register")'; 
        console.log(`Process ${processId}: Using generic Register button selector: '${registerButtonSelector}'.`);
        
        let registerTimeout;
        if (isTestMode) {
            registerTimeout = 10000; // Fixed 10 seconds for test mode
            console.log(`Process ${processId}: Test Mode - Register button timeout fixed at ${registerTimeout / 1000}s.`);
        } else {
            const targetTimeObj = new Date(targetBookingTime);
            const timeoutTargetTime = new Date(targetTimeObj.getTime() + (5 * 60 * 1000)); // เพิ่ม 5 นาทีจากเวลา Booking เป้าหมาย
            const currentTimeMs = Date.now();
            const dynamicTimeout = timeoutTargetTime.getTime() - currentTimeMs;

            registerTimeout = Math.max(5000, dynamicTimeout); // อย่างน้อย 5 วินาที
            registerTimeout = Math.min(registerTimeout, 600000); // ไม่เกิน 10 นาที (600,000 ms)
            
            console.log(`Process ${processId}: Real Mode - Register button dynamic timeout: ${registerTimeout / 1000}s (Target: ${targetBookingTime}, Timeout until: ${timeoutTargetTime.toLocaleString()}).`);
        }

        console.log(`Process ${processId}: Waiting for "Register" button (timeout: ${registerTimeout / 1000}s)...`);
        await page.waitForSelector(registerButtonSelector, { state: 'visible', timeout: registerTimeout });
        console.log(`Process ${processId}: Clicking "Register" button...`);
        await page.click(registerButtonSelector);

        // 2. รอให้รายการสาขาปรากฏและเลือกสาขา
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        let displayBranchName = branchTextCorrectionMap[branch];
        if (!displayBranchName) {
            displayBranchName = branch;
        }
        const branchButtonSelector = `button:has-text("${displayBranchName}")`; 
        console.log(`Process ${processId}: Using generic branch button selector: '${branchButtonSelector}'.`);

        const branchTimeout = 5000; 
        console.log(`Process ${processId}: Waiting for branch list and selecting: ${displayBranchName} (timeout: ${branchTimeout / 1000}s)...`);
        await page.waitForSelector(branchButtonSelector, { state: 'visible', timeout: branchTimeout });
        await page.click(branchButtonSelector);

        // --- ตรวจสอบและรอ CAPTCHA (หากปรากฏ) ---
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const nextButtonAfterBranchOrCaptchaSelector = 'button:has-text("Next")'; 
        console.log(`Process ${processId}: Using generic Next button selector: '${nextButtonAfterBranchOrCaptchaSelector}'.`);
        
        console.log(`Process ${processId}: Checking for "Next" button after branch selection...`);
        // Timeout สำหรับปุ่ม Next จะสั้นลง เพราะ CAPTCHA ถูกจัดการใน handleRandomCaptcha แล้ว
        const nextButtonTimeout = isTestMode ? 5000 : 10000; // 5s for test, 10s for real
        await page.waitForSelector(nextButtonAfterBranchOrCaptchaSelector, { state: 'visible', timeout: nextButtonTimeout });
        console.log(`Process ${processId}: Clicking "Next" button after branch selection...`);
        await page.click(nextButtonAfterBranchOrCaptchaSelector);


        // 4. รอให้ Calendar Grid ปรากฏและเลือกวันที่
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const dayCellSelector = `div#calendar-grid button.day-cell:has-text("${date}")`;
        console.log(`Process ${processId}: Waiting for calendar and selecting date: ${date}`);
        await page.waitForSelector(dayCellSelector, { state: 'visible', timeout: 5000 });
        await page.click(dayCellSelector);

        // 5. รอให้ Time Slots ปรากฏและเลือกเวลา
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const timeSlotSelector = `div.button-grid button:has-text("${time}")`;
        console.log(`Process ${processId}: Waiting for time slots and selecting: ${time}`);
        await page.waitForSelector(timeSlotSelector, { state: 'visible', timeout: 5000 });
        await page.click(timeSlotSelector);

        // 6. คลิกปุ่ม "Confirm" (หลังจากเลือกเวลา)
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const confirmOptionsButtonSelector = 'button.primary:has-text("Confirm")';
        console.log(`Process ${processId}: Clicking "Confirm" button after selecting time...`);
        await page.waitForSelector(confirmOptionsButtonSelector, { state: 'visible', timeout: 5000 });
        await page.click(confirmOptionsButtonSelector);

        // 7. คลิก Checkbox (input id="final-checkbox")
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const finalCheckboxSelector = 'input#final-checkbox';
        console.log(`Process ${processId}: Checking final checkbox...`);
        await page.waitForSelector(finalCheckboxSelector, { state: 'visible', timeout: 5000 });
        await page.check(finalCheckboxSelector);

        // 8. รอนาน 2-5 วินาที หรือรอให้ปุ่ม "Confirm Booking" ปรากฏและคลิก
        // ตรวจสอบ CAPTCHA ก่อนดำเนินการ
        await handleRandomCaptcha(page, processId, isTestMode);
        const confirmBookingButtonSelector = 'button.primary:has-text("Confirm Booking")';
        console.log(`Process ${processId}: Waiting for "Confirm Booking" button...`);
        await page.waitForSelector(confirmBookingButtonSelector, { state: 'visible', timeout: 10000 });
        console.log(`Process ${processId}: Clicking "Confirm Booking" button...`);
        await page.click(confirmBookingButtonSelector);


        console.log(`Process ${processId} completed successfully on ${browserType}`);
        res.json({ status: 'success', message: `Booking process ${processId} completed successfully on ${browserType}` });

    } catch (error) {
        console.error(`Error in process ${processId} on ${browserType}:`, error);
        if (activeProcesses.has(processId)) {
            const { browserContext } = activeProcesses.get(processId);
            if (browserContext) await browserContext.close();
            activeProcesses.delete(processId);
        }
        res.status(500).json({ status: 'error', message: `Booking process ${processId} failed: ${error.message}` });
    } finally {
        // ไม่ต้องปิด BrowserContext ที่นี่แล้ว
    }
});

app.post('/stop-booking-process', async (req, res) => {
    const { processId } = req.body;
    if (activeProcesses.has(processId)) {
        const { browserContext } = activeProcesses.get(processId);
        try {
            if (browserContext) await browserContext.close();
            activeProcesses.delete(processId);
            console.log(`Process ${processId} browser closed.`);
            res.json({ status: 'success', message: `Process '${processId}' stopped successfully.` });
        } catch (error) {
            console.error(`Error closing browser for process ${processId}:`, error);
            res.status(500).json({ status: 'error', message: `Failed to stop process '${processId}': ${error.message}` });
        }
    } else {
        res.status(404).json({ status: 'error', message: `Process ID '${processId}' not found or not running.` });
    }
});

app.get('/get-active-processes', (req, res) => {
    const processes = Array.from(activeProcesses.keys());
    res.json({ status: 'success', activeProcesses: processes });
});


app.listen(PORT, () => {
    console.log(`Backend server listening at http://localhost:${PORT}`);
});