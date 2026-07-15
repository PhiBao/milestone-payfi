import { chromium } from "playwright-core";

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN;

if (!executablePath) {
  throw new Error(
    "Set CHROME_BIN, PUPPETEER_EXECUTABLE_PATH, or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a Chrome binary."
  );
}

const baseUrl = process.env.MILESTONE_PAYFI_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Protected work payment");

  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  if (desktopOverflow > 1) {
    throw new Error(`Desktop horizontal overflow: ${desktopOverflow}`);
  }
  await page.screenshot({ path: "/tmp/milestone-payfi-desktop.png", fullPage: true });

  const suffix = Date.now().toString().slice(-5);
  await page.getByRole("button", { name: "New room" }).first().click();
  await page.getByLabel("Task title").fill(`Verification task ${suffix}`);
  await page.getByLabel("Amount USDC").fill("250");
  await page.getByLabel("Summary").fill("One funded milestone for a production handoff with launch support.");
  await page.getByLabel("Deliverable").fill("Responsive page design, implementation handoff, and final QA notes.");
  await page.getByLabel("Client name").fill("Orbit Studio");
  await page.getByLabel("Client email").fill("finance@orbit.example");
  await page.getByLabel("Client wallet").fill("0x1111111111111111111111111111111111111111");
  await page.getByLabel("Freelancer name").fill("Maya Rivera");
  await page.getByLabel("Freelancer email").fill("maya@example.dev");
  await page.getByLabel("Freelancer wallet").fill("0x2222222222222222222222222222222222222222");
  await page.getByLabel("Milestone title").fill("Launch page handoff");
  await page.getByRole("button", { name: "Create task room" }).click();

  await page.waitForSelector(`text=Verification task ${suffix}`);
  await page.waitForSelector("text=Orbit Studio pays Maya Rivera");
  await page.waitForSelector("text=Payment room");
  await page.waitForSelector("text=Create onchain milestone");
  await page.screenshot({ path: "/tmp/milestone-payfi-flow-complete.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("text=Protected work payment");
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  if (mobileOverflow > 1) {
    throw new Error(`Mobile horizontal overflow: ${mobileOverflow}`);
  }
  await page.screenshot({ path: "/tmp/milestone-payfi-mobile.png", fullPage: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        screenshots: [
          "/tmp/milestone-payfi-desktop.png",
          "/tmp/milestone-payfi-flow-complete.png",
          "/tmp/milestone-payfi-mobile.png"
        ]
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
