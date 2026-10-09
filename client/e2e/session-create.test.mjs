import test from 'node:test'
import assert from 'node:assert/strict'
import { By } from 'selenium-webdriver'
import { BASE_URL, buildDriver, waitForTestId, waitForTestIdText, screenshot } from './driver.mjs'

test('session create: publishes and shows a 6-digit code with QR', async (t) => {
  const driver = buildDriver()
  t.after(async () => {
    await driver.quit()
  })

  try {
    await driver.get(BASE_URL)

    const startBtn = await waitForTestId(driver, 'start-sharing')
    await startBtn.click()

    const message = `selenium smoke ${Date.now()}`
    const messageInput = await waitForTestId(driver, 'publish-message-input')
    await messageInput.sendKeys(message)

    // Live-P2P mode (e.g. no MongoDB) requires a password to publish; stored
    // open mode has no password field. Fill it only when present.
    const pwFields = await driver.findElements(By.css('[data-testid="publish-password-input"]'))
    if (pwFields.length > 0) {
      await pwFields[0].sendKeys('selenium-test-password')
    }

    const launchBtn = await waitForTestId(driver, 'publish-launch')
    await launchBtn.click()

    const code = await waitForTestIdText(driver, 'session-code', /^\d{6}$/, 30000)
    assert.match(code, /^\d{6}$/, `session code should be 6 digits, got "${code}"`)

    await waitForTestId(driver, 'session-qr', 10000)
  } catch (err) {
    await screenshot(driver, 'session-create-failure').catch(() => {})
    throw err
  }
})
