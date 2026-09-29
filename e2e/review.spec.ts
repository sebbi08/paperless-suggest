import { expect, test, type Page } from '@playwright/test'

const vocabulary = {
  inboxTagId: 1,
  tags: [
    { id: 2, name: 'Rechnung' },
    { id: 3, name: 'Telefon/Internet' },
  ],
  correspondents: [{ id: 10, name: 'Deutsche Telekom AG' }],
}

const detail = (id: number) => ({
  document: {
    id,
    title: `scan_${id}`,
    content: `OCR text ${id} `.repeat(200),
    correspondentId: null,
    tagIds: [1],
    modified: `m${id}`,
    added: 'a',
  },
  suggestion: {
    documentId: id,
    status: 'ready',
    title: `Telekom Rechnung ${id}`,
    correspondentId: 10,
    proposedCorrespondent: null,
    tagIds: [2],
    proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] }],
    matchedNotes: {},
    model: 'qwen3-14b',
    error: null,
    docModified: `m${id}`,
    updatedAt: 'u',
  },
  vocabulary,
})

async function mockApi(page: Page) {
  const applied: unknown[] = []
  await page.route('**/api/status', (r) =>
    r.fulfill({
      json: {
        paperless: { ok: true, error: null },
        llm: { ok: true, model: 'qwen3-14b', error: null },
        lastPollAt: 'x',
        counts: { ready: 2, pending: 0, error: 0, noText: 0 },
      },
    }),
  )
  await page.route('**/api/queue/next**', (r) => {
    const after = new URL(r.request().url()).searchParams.get('after')
    r.fulfill({ json: { documentId: after === null ? 1 : after === '1' ? 2 : null } })
  })
  await page.route(/\/api\/documents\/\d+$/, (r) => {
    const id = Number(new URL(r.request().url()).pathname.split('/').pop())
    r.fulfill({ json: detail(id) })
  })
  await page.route(/\/api\/documents\/\d+\/thumb$/, (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"/>' }),
  )
  await page.route(/\/api\/documents\/\d+\/preview$/, (r) => r.fulfill({ contentType: 'text/html', body: '<p>PDF</p>' }))
  await page.route(/\/api\/documents\/\d+\/apply$/, (r) => {
    applied.push(r.request().postDataJSON())
    r.fulfill({ json: { status: 'applied' } })
  })
  return applied
}

test('apply & next walks through the inbox', async ({ page }) => {
  const applied = await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  await page.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }).click()
  await page.getByRole('button', { name: /^Apply/ }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 2')
  expect(applied[0]).toEqual({
    title: 'Telekom Rechnung 1',
    correspondent: { id: 10 },
    tags: [{ id: 2 }, { id: 3 }],
    expectedModified: 'm1',
  })
})

test('Enter applies on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard shortcuts are a desktop feature')
  const applied = await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 2')
  expect(applied).toHaveLength(1)
  await expect(page.getByTitle('Document preview')).toBeVisible()
})

test('action bar stays reachable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile layout only')
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  const apply = page.getByRole('button', { name: /^Apply/ })
  await expect(apply).toBeInViewport()
  await page.mouse.wheel(0, 3000)
  await expect(apply).toBeInViewport()
  await expect(page.getByAltText('Document thumbnail')).toBeVisible()
  await expect(page.getByTitle('Document preview')).toBeHidden()
})
