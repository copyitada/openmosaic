#!/usr/bin/env node
/**
 * Browser smoke test for the UI. Requires the dev server on :3000 and the mock
 * provider on :4010 (see scripts/mock-provider.mjs).
 *
 *   node scripts/ui-smoke.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000'
const MOCK_URL = process.env.MOCK_URL ?? 'http://127.0.0.1:4010/v1'

let checks = 0
let failures = 0

function check(name, condition, detail) {
  checks++
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  console.log('\nOnboarding')
  await page.waitForSelector('.empty-state h1', { timeout: 15_000 })
  check('empty state renders', (await page.textContent('.empty-state h1'))?.includes('What can I help with'))
  const sidebarWidth = await page.evaluate(
    () => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0,
  )
  check('sidebar uses the 260px rail', Math.abs(sidebarWidth - 260) <= 1, String(sidebarWidth))

  // The key gate is visible before a provider is configured.
  check('key prompt is shown', await page.locator('.composer-key').isVisible())

  console.log('\nSettings')
  await page.locator('.composer-key').click()
  await page.waitForSelector('.modal')
  await page.fill('#base-url', MOCK_URL)
  await page.fill('#api-key', 'test-key')
  await page.fill('#model', 'mock-agent')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await page.waitForSelector('.test-result.ok', { timeout: 20_000 })
  check('connection test succeeds', true)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForSelector('.modal', { state: 'detached' })
  check('settings dialog closes on save', true)

  console.log('\nChat streaming')
  const prompt = 'Create hello.js and run it.'
  await page.fill('textarea', prompt)
  await page.press('textarea', 'Enter')

  await page.waitForSelector('.msg-row.user', { timeout: 10_000 })
  check('user message appears', (await page.textContent('.msg-row.user'))?.includes(prompt))

  await page.waitForSelector('.tool-card', { timeout: 20_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.tool-card').length >= 2,
    undefined,
    { timeout: 30_000 },
  )
  const labels = await page.locator('.tool-card .tool-label').allTextContents()
  check('tool cards render for both calls', labels.join(',') === 'Wrote file,Ran command', labels.join(','))

  await page.waitForSelector('.tool-card .tool-status.ok', { timeout: 20_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.tool-card .tool-status.ok').length >= 2,
    undefined,
    { timeout: 30_000 },
  )
  check('both tool calls finish successfully', true)

  await page.waitForFunction(
    () => document.querySelector('.msg-row.assistant')?.textContent?.includes('hello from mock agent'),
    undefined,
    { timeout: 30_000 },
  )
  check('assistant reply streams into the transcript', true)

  const runningCount = await page.locator('.tool-status.running').count()
  check('no tool stays stuck in running state', runningCount === 0, `${runningCount} running`)

  const composerBox = await page.locator('.composer').boundingBox()
  check('composer stays inside the viewport', Boolean(composerBox && composerBox.y + composerBox.height <= 900))

  // Reply actions stay out of the way until the turn is hovered.
  const actions = page.locator('.msg-actions').first()
  const restingOpacity = await actions.evaluate((el) => getComputedStyle(el).opacity)
  await page.locator('.msg-row.assistant').first().hover()
  await page.waitForTimeout(220)
  const hoveredOpacity = await actions.evaluate((el) => getComputedStyle(el).opacity)
  check(
    'reply actions reveal on hover',
    Number(restingOpacity) < 0.1 && Number(hoveredOpacity) > 0.9,
    `${restingOpacity} -> ${hoveredOpacity}`,
  )

  console.log('\nFiles panel')
  await page.locator('.topbar-actions .icon-btn').first().click()
  await page.waitForSelector('.file-panel', { timeout: 10_000 })
  await page.waitForSelector('.file-row', { timeout: 10_000 })
  const fileNames = await page.locator('.file-row span').allTextContents()
  check('workspace panel lists the generated file', fileNames.includes('hello.js'), fileNames.join(','))
  await page.locator('button.file-row', { hasText: 'hello.js' }).click()
  await page.waitForSelector('.code-view', { timeout: 10_000 })
  check(
    'file preview shows the file contents',
    ((await page.textContent('.code-view')) ?? '').includes('console.log'),
  )
  await fs.mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/ui-files.png' })
  await page.locator('.file-panel-actions .icon-btn').last().click()

  console.log('\nPersistence')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.msg-row.user', { timeout: 15_000 })
  check('conversation survives a reload', Boolean(await page.locator('.msg-row.user').count()))
  check('settings survive a reload', (await page.textContent('.topbar-model'))?.includes('mock-agent'))

  const layout = await page.evaluate(() => {
    const column = document.querySelector('.chat-inner')?.getBoundingClientRect()
    const composer = document.querySelector('.composer')?.getBoundingClientRect()
    const bubble = document.querySelector('.bubble')
    const bubbleBox = bubble?.getBoundingClientRect()
    const mid = (box) => (box.left + box.right) / 2
    return {
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0,
      columnWidth: Math.round(column?.width ?? 0),
      composerWidth: Math.round(composer?.width ?? 0),
      centerOffset: Math.round(Math.abs(mid(composer) - mid(column))),
      bubbleOffset: Math.round(mid(bubbleBox) - mid(column)),
      bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : '',
      assistantBg: getComputedStyle(document.querySelector('.msg-body')).backgroundColor,
      composerRadius: getComputedStyle(document.querySelector('.composer')).borderRadius,
      pageGlow: getComputedStyle(document.body, '::before').backgroundImage,
      fontSize: getComputedStyle(document.querySelector('.msg-body')).fontSize,
    }
  })
  check('no horizontal overflow', layout.horizontalOverflow <= 0, JSON.stringify(layout))
  check('transcript column is capped at 768px', layout.columnWidth <= 769, JSON.stringify(layout))
  check('composer matches the transcript width', Math.abs(layout.composerWidth - 768) <= 2, JSON.stringify(layout))
  check('composer is centered in the column', layout.centerOffset <= 2, JSON.stringify(layout))
  check('user turn sits right of centre', layout.bubbleOffset > 60, JSON.stringify(layout))
  check('user turn has the one elevated surface', layout.bubbleBg !== 'rgba(0, 0, 0, 0)', layout.bubbleBg)
  check('assistant text has no bubble', layout.assistantBg === 'rgba(0, 0, 0, 0)', layout.assistantBg)
  check('composer is a 26px capsule', layout.composerRadius === '26px', layout.composerRadius)
  check('body text is 16px', layout.fontSize === '16px', layout.fontSize)
  check('page has no decorative gradient', layout.pageGlow === 'none', layout.pageGlow)

  await fs.mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/ui.png' })

  console.log('\nTheme')
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.locator('.theme-toggle').click()
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme)
  check('theme toggle flips the document theme', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`)
  const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check(
    'light theme paints a white canvas',
    themeAfter !== 'light' || canvas === 'rgb(255, 255, 255)',
    `${themeAfter}: ${canvas}`,
  )
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'artifacts/ui-light.png' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.msg-row.user', { timeout: 15_000 })
  check(
    'theme choice survives a reload',
    (await page.evaluate(() => document.documentElement.dataset.theme)) === themeAfter,
  )
  await page.locator('.theme-toggle').click()

  console.log('\nError handling')
  // Regression: the app server (or a proxy in front of it) answering with an HTML page
  // must produce a plain explanation, never "... is not valid JSON".
  await page.route('**/api/test', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!DOCTYPE html><html><body><h1>The page could not be found</h1></body></html>',
    }),
  )
  await page.locator('.topbar-actions .icon-btn').last().click()
  await page.waitForSelector('.modal')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await page.waitForSelector('.test-result.fail', { timeout: 15_000 })
  const htmlResult = (await page.textContent('.test-result.fail')) ?? ''
  check(
    'HTML response is explained instead of a JSON syntax error',
    htmlResult.includes('did not answer with data') && !/is not valid JSON/i.test(htmlResult),
    htmlResult,
  )
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForSelector('.modal', { state: 'detached' })
  await page.unroute('**/api/test')

  await page.locator('.topbar-actions .icon-btn').last().click()
  await page.waitForSelector('.modal')
  await page.fill('#base-url', 'http://127.0.0.1:4999/v1')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForSelector('.modal', { state: 'detached' })
  await page.fill('textarea', 'is this thing on?')
  await page.press('textarea', 'Enter')
  await page.waitForSelector('.notice.error', { timeout: 20_000 })
  const errorText = (await page.textContent('.notice.error')) ?? ''
  check('unreachable provider surfaces an inline error', errorText.includes('Could not reach'), errorText)
  check('composer re-enables after a failed turn', await page.locator('.send-btn:not(.stop)').isVisible())

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n'))
  const relevantErrors = consoleErrors.filter((text) => !/favicon|Download the React DevTools/i.test(text))
  check('no console errors', relevantErrors.length === 0, relevantErrors.join('\n'))
} catch (error) {
  failures++
  console.error('\nUnexpected failure:', error.message)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} UI checks passed`)
process.exit(failures > 0 ? 1 : 0)
