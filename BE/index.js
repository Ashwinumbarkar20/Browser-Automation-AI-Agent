import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Agent,tool,run } from "@openai/agents";
import OpenAI from "openai";
import cors from "cors";
import { url } from "inspector";
import { string } from "zod/v4";
import {z} from 'zod'
import { chromium } from "playwright";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, (error) =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);

//3.create the tools
let browser, context, page;



export async function getBrowser() {
  if (!browser || !context || !page) {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    page = await context.newPage();
  }
  return { browser, context, page };
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = context = page = null;
  }
}

export const openBrowser = tool({
	name: "open_browser",
	description: "Launch a Chrome browser instance.",
	parameters: z.object({}),
	async execute() {
	  await getBrowser();
	  console.log("Open Browser")
	  return "✅ Browser opened";
	},
  });

  export const visitUrl = tool({
	name: "visit_url",
	description: "Navigate to a URL in the browser",
	parameters: z.object({ url: z.string() }),
	async execute({ url }) {
	  const { page } = await getBrowser();
	  console.log("visit Browser")
	  await page.goto(url, { waitUntil: "domcontentloaded" });
	  await page.waitForTimeout(2000);
	  return `✅ Visited ${url}`;
	},
  });

  export const clickElement = tool({
	name: "click_element",
	description: "Click an element by CSS selector",
	parameters: z.object({ selector: z.string() }),
	async execute({ selector }) {
	  const { page } = await getBrowser();
	  console.log("clicking element")
	  await page.click(selector, { timeout: 5000 });
	  return `✅ Clicked ${selector}`;
	},
  });

  export const clickByText = tool({
	name: "click_by_text",
	description: "Click an element by visible text",
	parameters: z.object({ text: z.string() }),
	async execute({ text }) {
	  const { page } = await getBrowser();
	  await page.click(`text="${text}"`);
	  console.log("clicking text")
	  return `✅ Clicked element with text: ${text}`;
	},
  });

  export const typeInto = tool({
	name: "type_into",
	description: "Type into a text input",
	parameters: z.object({
	  selector: z.string(),
	  value: z.string(),
	}),
	async execute({ selector, value }) {
	  const { page } = await getBrowser();
	  await page.fill(selector, value);
	  console.log("typing into")
	  return `✅ Typed "${value}" into ${selector}`;
	},
  });

  export const typeByLabel = tool({
	name: "type_by_label",
	description: "Types a value into an input field based on its label or placeholder text",
	parameters: z.object({ label: z.string(), value: z.string() }),
	async execute({ label, value }) {
	  const { page } = await getBrowser();
	  console.log("selecting label")
	  // Try placeholder first
	  let selector = `input[placeholder="${label}"]`;
	  if (await page.$(selector)) {
		await page.fill(selector, value);
		return `✅ Typed "${value}" into input with placeholder "${label}"`;
	  }
  
	  // Try label text
	  selector = `label:text("${label}") >> input`;
	  if (await page.$(selector)) {
		await page.fill(selector, value);
		return `✅ Typed "${value}" into input with label "${label}"`;
	  }
  
	  // Fallback
	  throw new Error(`Input field with label or placeholder "${label}" not found`);
	},
  });

  export const takeScreenshot = tool({
	name: "take_screenshot",
	description: "Take a screenshot of the current page",
	parameters: z.object({ filename: z.string() }),
	async execute({ filename }) {
	  const { page } = await getBrowser();
	  const path = `screenshots/${filename}.png`;
	  await page.screenshot({ path });
	  console.log("screen shot")
	  return `📸 Screenshot saved: ${path}`;
	},
  });

  export const closeBrowserTool = tool({
	name: "close_browser",
	description: "Close the browser",
	parameters: z.object({}),
	async execute() {
		console.log("close Browser")
	  await closeBrowser();
	  return "✅ Browser closed";
	},
  });

  async function rewritePrompt(originalPrompt) {
	const response = await openai.chat.completions.create({
	  model: process.env.MODEL,
	  messages: [
		{
		  role: "system",
		  content: "You are an expert prompt engineer. Rewrite the user prompt to make it clearer, more concise, and unambiguous."
		},
		{
		  role: "user",
		  content: originalPrompt
		}
	  ],
	  temperature: 0.7,
	});
  
	return response.choices[0].message.content;
  }

//2. create the agent 
const agent = new Agent({
	name: "History Tutor",
	model: process.env.MODEL,
	instructions: `
	You are "Browser Automation AI", an intelligent agent that simulates a human interacting with a web browser using automation tools. 

### Your Mission
- Follow user instructions to navigate websites, click buttons, fill forms, and take screenshots.
- Use the provided tools to perform all actions. Do not try to perform actions without tools.
- Always produce outputs in the structured cycle: Plan → Action → Screenshot → Confirmation.
- For input fields, you can use "type_by_label" tool with the visible label or placeholder text.
- Only use "type_into" if you know the exact CSS selector.

### Tools You Have
1. open_browser → Opens a Chrome browser.
2. visit_url → Navigate to a specified URL.
3. click_element → Click a specified CSS selector.
4. click_by_text → Click an element using its visible text.
5. type_into → Type a specified value into a selector.
6. type_random → Type random strings for fields like email or password.
7. take_screenshot → Capture a screenshot of the current page.
8. close_browser → Close the browser.

### Core Behavior
1. **Planning:** Before each action, describe your plan step by step.
2. **Execution:** Perform one action at a time using the correct tool.
3. **Verification:** After each action, optionally take a screenshot for confirmation.
4. **Error Handling:** If you cannot find an element or URL, explain clearly and prompt the user if necessary. Do not hallucinate selectors or actions.
5. **Fallback:** If the user gives a vague instruction (like “amazon”), search for the site on Google first before performing any actions.
6. **Output Format:** Strictly follow this format:
   - **Plan:** What you intend to do step by step.
   - **Action:** What action/tool you executed.
   - **Screenshot:** The screenshot filename or base64 image if available.
   - **Confirmation:** A concise confirmation of what was accomplished.

### Constraints
- Never perform actions outside the available tools.
- Be concise but precise.
- Always provide visual proof via screenshots.
- Ask for clarification if instructions are ambiguous.

	`,
	tools: [  openBrowser,
		visitUrl,
		clickByText,
		clickElement,
		typeInto,
		typeByLabel,
		takeScreenshot,
		closeBrowserTool,],
  });

//4.create route
app.post('/api/ask',async (req,res)=>{
	
	const {prompt}=req.body
	const rewritten = await rewritePrompt(prompt);
	console.log(rewritten)
	if(rewritten){
		try{
const result=await run(agent,rewritten)
if(result)
{
	res.status(200).json({message:result.finalOutput})
}
		}
		catch(e){
			console.log(e)
		}
	}
})
