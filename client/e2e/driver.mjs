// Selenium E2E driver harness for the Quick Share client.
//
// Usage:
//   BASE_URL=http://localhost:4000 node --test e2e/*.test.mjs
//
// Chrome is launched headless. If Google Chrome is not installed, set
// CHROME_BIN=/path/to/chromium (or rely on auto-detection of common paths).
// Driver binaries are resolved by Selenium Manager (built into
// selenium-webdriver ≥4.6), so no pinned chromedriver dependency is needed —
// pinning one breaks every time CI's Chrome moves a major version.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Builder, By, until } from 'selenium-webdriver'
import chrome from 'selenium-webdriver/chrome.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4000'
export const SCREENSHOTS_DIR = join(__dirname, 'screenshots')

const CHROME_BINARY_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** Resolve the Chrome/Chromium binary: CHROME_BIN wins, then common paths. */
export function resolveChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  return CHROME_BINARY_CANDIDATES.find((p) => existsSync(p)) ?? null
}

/** Build a headless Chrome WebDriver (driver binary via Selenium Manager). */
export function buildDriver({ headless = true } = {}) {
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
  if (headless) args.push('--headless=new')

  const options = new chrome.Options().addArguments(...args)
  const binary = resolveChromeBinary()
  if (binary) options.setChromeBinaryPath(binary)

  return new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build()
}

/** Wait for an element carrying [data-testid="<id>"] to be located and return it. */
export async function waitForTestId(driver, id, timeout = 10000) {
  return driver.wait(
    until.elementLocated(By.css(`[data-testid="${id}"]`)),
    timeout,
    `Timed out after ${timeout}ms waiting for [data-testid="${id}"]`,
  )
}

/**
 * Wait until the element's text matches `pattern` (polls — guards against
 * reading React state a commit before the text paints) and return the text.
 */
export async function waitForTestIdText(driver, id, pattern, timeout = 15000) {
  const el = await waitForTestId(driver, id, timeout)
  const deadline = Date.now() + timeout
  for (;;) {
    const text = ((await el.getText()) ?? '').trim()
    if (pattern.test(text)) return text
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for [data-testid="${id}"] text to match ${pattern}; last text: "${text}"`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Save a PNG screenshot to e2e/screenshots/ and return its path. */
export async function screenshot(driver, name = 'screenshot') {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true })
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '-')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(SCREENSHOTS_DIR, `${safeName}-${stamp}.png`)
  const base64 = await driver.takeScreenshot()
  writeFileSync(file, base64, 'base64')
  return file
}
