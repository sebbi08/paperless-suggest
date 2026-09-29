import type { PaperlessClient } from '../../src/paperless/client'

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** A PaperlessClient whose methods throw unless overridden. */
export function fakePaperless(overrides: Partial<PaperlessClient> = {}): PaperlessClient {
  const missing = (name: string) => async (): Promise<never> => {
    throw new Error(`fakePaperless.${name} was not stubbed`)
  }
  return {
    listInboxDocuments: missing('listInboxDocuments'),
    getDocument: missing('getDocument'),
    listTags: missing('listTags'),
    listCorrespondents: missing('listCorrespondents'),
    listFiledDocuments: missing('listFiledDocuments'),
    createTag: missing('createTag'),
    createCorrespondent: missing('createCorrespondent'),
    updateDocument: missing('updateDocument'),
    fetchFile: missing('fetchFile'),
    ...overrides,
  }
}
