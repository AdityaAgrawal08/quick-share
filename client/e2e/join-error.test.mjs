import test from 'node:test'
import assert from 'node:assert/strict'
import { BASE_URL, buildDriver, waitForTestId, screenshot } from './driver.mjs'

test('join error: invalid code shows a non-empty error', async (t) => {
  const driver = buildDriver()
  t.after(async () => {
    await driver.quit()
  })

  try {
    await driver.get(BASE_URL)

    const codeInput = await waitForTestId(driver, 'join-code-input')
    await codeInput.sendKeys('999999')

    const submitBtn = await waitForTestId(driver, 'join-submit')
    await submitBtn.click()

    const errorEl = await waitForTestId(driver, 'join-error', 30000)
    const text = (await errorEl.getText()).trim()
    assert.ok(text.length > 0, 'join-error should contain non-empty text')
  } catch (err) {
    await screenshot(driver, 'join-error-failure').catch(() => {})
    throw err
  }
})
