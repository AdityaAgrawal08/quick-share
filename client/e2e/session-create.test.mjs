import test from 'node:test'
import assert from 'node:assert/strict'
import { BASE_URL, buildDriver, waitForTestId, screenshot } from './driver.mjs'

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

    const launchBtn = await waitForTestId(driver, 'publish-launch')
    await launchBtn.click()

    const codeEl = await waitForTestId(driver, 'session-code', 30000)
    const code = (await codeEl.getText()).trim()
    assert.match(code, /^\d{6}$/, `session code should be 6 digits, got "${code}"`)

    await waitForTestId(driver, 'session-qr', 10000)
  } catch (err) {
    await screenshot(driver, 'session-create-failure').catch(() => {})
    throw err
  }
})
