import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Agent, tool, run } from "@openai/agents";
import OpenAI from "openai";
import cors from "cors";
import { z } from 'zod';
import { chromium } from "playwright";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Create screenshots directory if it doesn't exist
const screenshotsDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// 1. Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);

// 3. Create the tools
let browser, context, page;
let browserInitializing = false;

export async function getBrowser() {
  // If browser is already initializing, wait for it
  if (browserInitializing) {
    console.log("⏳ Browser is already initializing, waiting...");
    while (browserInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { browser, context, page };
  }

  // If browser already exists and is connected, return it
  if (browser && browser.isConnected() && context && page) {
    console.log("♻️ Using existing browser instance");
    return { browser, context, page };
  }

  // Initialize new browser
  browserInitializing = true;
  try {
    console.log("🚀 Launching new browser instance...");
    
    // Close any existing browser first
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log("Warning: Error closing existing browser:", e.message);
      }
    }
    
    browser = await chromium.launch({ 
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });
    
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    
    page = await context.newPage();
    
    // Add better error handling
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    page.on('close', () => console.log('Page closed'));
    
    console.log("✅ Browser launched successfully");
  } catch (error) {
    console.error("❌ Failed to launch browser:", error);
    browser = context = page = null;
    throw error;
  } finally {
    browserInitializing = false;
  }
  
  return { browser, context, page };
}

export async function closeBrowser() {
  if (browser) {
    console.log("🔒 Closing browser...");
    try {
      if (page) {
        await page.close();
      }
      if (context) {
        await context.close();
      }
      await browser.close();
      console.log("✅ Browser closed successfully");
    } catch (error) {
      console.error("❌ Error closing browser:", error.message);
    } finally {
      browser = context = page = null;
      browserInitializing = false;
    }
  }
}

export const openBrowser = tool({
  name: "open_browser",
  description: "Launch a Chrome browser instance.",
  parameters: z.object({}),
  async execute() {
    try {
      // Check if browser is already open
      if (browser && browser.isConnected() && context && page) {
        console.log("✅ Browser is already open");
        return "✅ Browser is already open and ready";
      }
      
      await getBrowser();
      console.log("✅ Browser opened successfully");
      return "✅ Browser opened successfully";
    } catch (error) {
      console.error("❌ Failed to open browser:", error.message);
      return `❌ Failed to open browser: ${error.message}`;
    }
  },
});

export const visitUrl = tool({
  name: "visit_url",
  description: "Navigate to a URL in the browser",
  parameters: z.object({ url: z.string() }),
  async execute({ url }) {
    try {
      const { page } = await getBrowser();
      console.log(`🌐 Navigating to ${url}...`);
      
      await page.goto(url, { 
        waitUntil: "networkidle",
        timeout: 30000 
      });
      
      // Wait a bit more for dynamic content
      await page.waitForTimeout(3000);
      
      const title = await page.title();
      console.log(`✅ Successfully visited ${url} - Title: ${title}`);
      return `✅ Successfully visited ${url} - Page Title: ${title}`;
    } catch (error) {
      console.error(`❌ Failed to visit ${url}:`, error.message);
      return `❌ Failed to visit ${url}: ${error.message}`;
    }
  },
});

export const getPageInfo = tool({
  name: "get_page_info",
  description: "Get information about the current page including title and visible elements",
  parameters: z.object({}),
  async execute() {
    try {
      const { page } = await getBrowser();
      const title = await page.title();
      const url = page.url();
      
      // Get visible buttons and links
      const buttons = await page.$$eval('button, input[type="submit"], input[type="button"]', 
        elements => elements.slice(0, 10).map(el => ({
          text: el.textContent?.trim() || el.value || 'No text',
          type: el.tagName.toLowerCase()
        }))
      );
      
      const links = await page.$$eval('a', 
        elements => elements.slice(0, 10).map(el => ({
          text: el.textContent?.trim() || 'No text',
          href: el.href
        })).filter(link => link.text && link.text !== 'No text')
      );
      
      const inputs = await page.$$eval('input, textarea', 
        elements => elements.slice(0, 10).map(el => ({
          type: el.type || 'text',
          placeholder: el.placeholder || '',
          name: el.name || '',
          id: el.id || ''
        }))
      );
      
      return `📄 Page Info:
Title: ${title}
URL: ${url}
Buttons: ${JSON.stringify(buttons, null, 2)}
Links: ${JSON.stringify(links, null, 2)}
Inputs: ${JSON.stringify(inputs, null, 2)}`;
    } catch (error) {
      return `❌ Failed to get page info: ${error.message}`;
    }
  },
});

export const clickElement = tool({
  name: "click_element",
  description: "Click an element by CSS selector",
  parameters: z.object({ selector: z.string() }),
  async execute({ selector }) {
    try {
      const { page } = await getBrowser();
      console.log(`🖱️ Clicking element: ${selector}`);
      
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector, { timeout: 5000 });
      await page.waitForTimeout(2000); // Wait for any resulting navigation/changes
      
      console.log(`✅ Successfully clicked ${selector}`);
      return `✅ Successfully clicked ${selector}`;
    } catch (error) {
      console.error(`❌ Failed to click ${selector}:`, error.message);
      return `❌ Failed to click ${selector}: ${error.message}`;
    }
  },
});

export const clickByText = tool({
  name: "click_by_text",
  description: "Click an element by visible text (buttons, links, etc.)",
  parameters: z.object({ text: z.string() }),
  async execute({ text }) {
    try {
      const { page } = await getBrowser();
      console.log(`🖱️ Clicking element with text: "${text}"`);
      
      // Try multiple approaches to find and click the element
      let clicked = false;
      
      // Try exact text match first
      try {
        await page.getByText(text, { exact: true }).click({ timeout: 5000 });
        clicked = true;
      } catch {}
      
      // Try partial text match
      if (!clicked) {
        try {
          await page.getByText(text, { exact: false }).click({ timeout: 5000 });
          clicked = true;
        } catch {}
      }
      
      // Try button role with name
      if (!clicked) {
        try {
          await page.getByRole('button', { name: text }).click({ timeout: 5000 });
          clicked = true;
        } catch {}
      }
      
      // Try link role with name
      if (!clicked) {
        try {
          await page.getByRole('link', { name: text }).click({ timeout: 5000 });
          clicked = true;
        } catch {}
      }
      
      if (clicked) {
        await page.waitForTimeout(2000);
        console.log(`✅ Successfully clicked element with text: "${text}"`);
        return `✅ Successfully clicked element with text: "${text}"`;
      } else {
        throw new Error(`Could not find clickable element with text: "${text}"`);
      }
    } catch (error) {
      console.error(`❌ Failed to click text "${text}":`, error.message);
      return `❌ Failed to click text "${text}": ${error.message}`;
    }
  },
});

export const typeInto = tool({
  name: "type_into",
  description: "Type into a text input using CSS selector",
  parameters: z.object({
    selector: z.string(),
    value: z.string(),
  }),
  async execute({ selector, value }) {
    try {
      const { page } = await getBrowser();
      console.log(`⌨️ Typing "${value}" into ${selector}`);
      
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.fill(selector, value);
      await page.waitForTimeout(1000);
      
      console.log(`✅ Successfully typed "${value}" into ${selector}`);
      return `✅ Successfully typed "${value}" into ${selector}`;
    } catch (error) {
      console.error(`❌ Failed to type into ${selector}:`, error.message);
      return `❌ Failed to type into ${selector}: ${error.message}`;
    }
  },
});

export const typeByLabel = tool({
  name: "type_by_label",
  description: "Type into an input field by label, placeholder, or name",
  parameters: z.object({ 
    label: z.string(),
    value: z.string() 
  }),
  async execute({ label, value }) {
    try {
      const { page } = await getBrowser();
      console.log(`⌨️ Typing "${value}" into field with label: "${label}"`);

      // Find all input fields and log their attributes
      const inputs = await page.$$eval('input', elements =>
        elements.map(el => ({
          type: el.type,
          placeholder: el.placeholder,
          name: el.name,
          id: el.id,
          ariaLabel: el.getAttribute('aria-label'),
          labelText: el.labels && el.labels.length > 0 ? el.labels[0].innerText : ''
        }))
      );
      console.log("Detected input fields:", inputs);

      // Try to match by label/placeholder/name/id/aria-label
      let selector = null;
      for (const input of inputs) {
        const labelLower = label.toLowerCase();
        if (
          (input.placeholder && input.placeholder.toLowerCase().includes(labelLower)) ||
          (input.name && input.name.toLowerCase().includes(labelLower)) ||
          (input.id && input.id.toLowerCase().includes(labelLower)) ||
          (input.ariaLabel && input.ariaLabel.toLowerCase().includes(labelLower)) ||
          (input.labelText && input.labelText.toLowerCase().includes(labelLower))
        ) {
          // Prefer password field for password
          if (labelLower.includes("password") && input.type === "password") {
            selector = input.id ? `input#${input.id}` : input.name ? `input[name='${input.name}']` : input.placeholder ? `input[placeholder='${input.placeholder}']` : null;
            break;
          }
          // Prefer text/email for username/login
          if ((labelLower.includes("user") || labelLower.includes("login") || labelLower.includes("id")) && (input.type === "text" || input.type === "email")) {
            selector = input.id ? `input#${input.id}` : input.name ? `input[name='${input.name}']` : input.placeholder ? `input[placeholder='${input.placeholder}']` : null;
            break;
          }
          // Fallback: first match
          if (!selector) {
            selector = input.id ? `input#${input.id}` : input.name ? `input[name='${input.name}']` : input.placeholder ? `input[placeholder='${input.placeholder}']` : null;
          }
        }
      }

      if (selector) {
        await page.fill(selector, value);
        return `✅ Typed "${value}" into field: "${label}"`;
      } else {
        return `❌ Could not find input field for: "${label}"`;
      }
    } catch (error) {
      console.error(`❌ Failed to type by label "${label}":`, error.message);
      return `❌ Failed to type by label "${label}": ${error.message}`;
    }
  },
});

export const submitForm = tool({
  name: "submit_form",
  description: "Submit a form by clicking submit button or pressing Enter",
  parameters: z.object({ 
    buttonText: z.string().optional().nullable() 
  }),
  async execute({ buttonText }) {
    try {
      const { page } = await getBrowser();
      console.log(`📝 Submitting form...`);
      
      if (buttonText) {
        // Try to find and click the specific button
        await page.getByRole('button', { name: new RegExp(buttonText, 'i') }).click({ timeout: 5000 });
        console.log(`✅ Clicked submit button: "${buttonText}"`);
      } else {
        // Try to find any submit button
        try {
          await page.click('button[type="submit"], input[type="submit"]', { timeout: 5000 });
          console.log(`✅ Clicked submit button`);
        } catch {
          // Fallback to Enter key
          await page.keyboard.press("Enter");
          console.log(`✅ Pressed Enter to submit`);
        }
      }
      
      // Wait for potential navigation/response
      await page.waitForTimeout(3000);
      return "✅ Form submitted successfully";
    } catch (error) {
      console.error(`❌ Failed to submit form:`, error.message);
      return `❌ Failed to submit form: ${error.message}`;
    }
  },
});

export const takeScreenshot = tool({
  name: "take_screenshot",
  description: "Take a screenshot of the current page",
  parameters: z.object({ filename: z.string() }),
  async execute({ filename }) {
    try {
      const { page } = await getBrowser();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fullFilename = `${filename}_${timestamp}.png`;
      const filepath = path.join(screenshotsDir, fullFilename);
      
      await page.screenshot({ 
        path: filepath,
        fullPage: true 
      });
      
      console.log(`📸 Screenshot saved: ${filepath}`);
      return `📸 Screenshot saved: ${fullFilename}`;
    } catch (error) {
      console.error(`❌ Failed to take screenshot:`, error.message);
      return `❌ Failed to take screenshot: ${error.message}`;
    }
  },
});

export const checkBrowserStatus = tool({
  name: "check_browser_status",
  description: "Check if browser is currently open and ready",
  parameters: z.object({}),
  async execute() {
    try {
      if (browser && browser.isConnected() && context && page) {
        const url = page.url();
        const title = await page.title();
        return `✅ Browser is open and ready\nCurrent URL: ${url}\nPage Title: ${title}`;
      } else {
        return "❌ Browser is not open";
      }
    } catch (error) {
      return `❌ Error checking browser status: ${error.message}`;
    }
  },
});

export const closeBrowserTool = tool({
  name: "close_browser",
  description: "Close the browser",
  parameters: z.object({}),
  async execute() {
    try {
      await closeBrowser();
      console.log("✅ Browser closed successfully");
      return "✅ Browser closed successfully";
    } catch (error) {
      console.error("❌ Failed to close browser:", error.message);
      return `❌ Failed to close browser: ${error.message}`;
    }
  },
});

async function rewritePrompt(originalPrompt) {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.MODEL || "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are an expert prompt engineer. Rewrite the user prompt to make it clearer and more specific for browser automation. 
          Break down complex tasks into clear, actionable steps. 
          For signup forms, specify typical fields like Name, Email, Password.
          For shopping tasks, break down into: search, select product, add to cart, etc.`
        },
        {
          role: "user",
          content: originalPrompt
        }
      ],
      temperature: 0.3,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("Failed to rewrite prompt:", error);
    return originalPrompt; // Return original if rewrite fails
  }
}

// 2. Create the agent with improved instructions
const agent = new Agent({
  name: "Browser Automation Agent",
  model: process.env.MODEL || "gpt-4",
  instructions: `
You are a Browser Automation Agent that controls web browsers using Playwright tools.
Follow these rules STRICTLY:

**TOOL USAGE ORDER:**
1. **open_browser** - ALWAYS start here (will reuse existing browser if already open)
2. **visit_url** - Navigate to the target website  
3. **get_page_info** - Understand what's on the page
4. **take_screenshot** - Capture current state
5. Use interaction tools (type_by_label, click_by_text, etc.)
6. **take_screenshot** - After each major action
7. **close_browser** - Always end here

🔧 **BROWSER MANAGEMENT:**
- The browser will automatically reuse existing instances
- Only call open_browser ONCE at the start
- Don't call open_browser multiple times in the same session

📋 **STEP-BY-STEP APPROACH:**
- Plan each action clearly before executing
- Take screenshots after important actions
- Handle errors gracefully - if something fails, try alternative approaches
- Never guess selectors or field names

🎯 **SPECIFIC SCENARIOS:**

**For Signup Forms:**
1. Look for fields like: "Name", "Email", "Password", "Username"
2. Use realistic test data: Name="John Doe", Email="john.doe@example.com", Password="TestPass123!"
3. Look for "Sign Up", "Register", "Create Account" buttons

**For Shopping (like Amazon):**
1. Use the search box to find products
2. Click on product from search results  
3. Look for "Add to Cart" or "Buy Now" buttons
4. Note: Don't actually complete purchases with real payment info

🛡️ **ERROR HANDLING:**
- If an element is not found, take a screenshot and explain what you see
- Try alternative approaches (different selectors, text matching)
- Always provide clear feedback about what succeeded/failed

⚡ **EXECUTION TIPS:**
- Wait for pages to load completely
- Take screenshots to verify actions worked
- Use get_page_info to understand page structure
- Be patient with dynamic content loading

Remember: Every action should have a clear purpose and verification step.
`,
  tools: [
    openBrowser,
    checkBrowserStatus,
    visitUrl,
    getPageInfo,
    clickByText,
    clickElement,
    typeInto,
    typeByLabel,
    takeScreenshot,
    submitForm,
    closeBrowserTool,
  ],
});

// 4. Create route with better error handling
app.post('/api/ask', async (req, res) => {
	try {
	  const { prompt } = req.body;
	  if (!prompt) {
		return res.status(400).json({ error: "Prompt is required" });
	  }
  
	  console.log("📝 Original prompt:", prompt);
	  const rewritten = await rewritePrompt(prompt);
	  console.log("✍️ Rewritten prompt:", rewritten);
  
	  let result;
	  try {
		result = await run(agent, rewritten, { maxTurns: 25 }); // bump limit if needed
	  } catch (err) {
		console.error("❌ Agent run error:", err.message);
		return res.status(500).json({
		  error: err.message || "Agent execution failed",
		  success: false
		});
	  }
  
	  if (result && result.finalOutput) {
		res.status(200).json({ 
		  message: result.finalOutput,
		  success: true 
		});
	  } else {
		res.status(500).json({ 
		  error: "No result received from agent",
		  success: false 
		});
	  }
	} catch (error) {
	  console.error("❌ API Error:", error);
	  res.status(500).json({ 
		error: error.message || "Internal server error",
		success: false 
	  });
	}
  });
  
// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  await closeBrowser();
  process.exit(0);
});