import type { PaperlessDocument, Vocabulary } from '../../src/paperless/types'

export const INBOX_ID = 1

export function makeVocabulary(): Vocabulary {
  return {
    inboxTagId: INBOX_ID,
    tags: [
      { id: 1, name: 'Inbox', isInboxTag: true, documentCount: 4 },
      { id: 2, name: 'Rechnung', isInboxTag: false, documentCount: 120 },
      { id: 3, name: 'Telefon/Internet', isInboxTag: false, documentCount: 14 },
      { id: 4, name: 'Versicherung', isInboxTag: false, documentCount: 30 },
      { id: 5, name: 'Müller "Bau"', isInboxTag: false, documentCount: 2 },
    ],
    correspondents: [
      { id: 10, name: 'Deutsche Telekom AG', documentCount: 30 },
      { id: 11, name: 'Stadtwerke München GmbH', documentCount: 12 },
      { id: 12, name: 'Allianz Versicherung', documentCount: 8 },
    ],
  }
}

export function makeDocument(overrides: Partial<PaperlessDocument> = {}): PaperlessDocument {
  return {
    id: 100,
    title: 'scan_0001',
    content: 'Deutsche Telekom AG\nRechnung September 2026\nBetrag 39,95 €',
    correspondent: null,
    tags: [INBOX_ID],
    created: '2026-09-14',
    added: '2026-09-14T10:00:00+02:00',
    modified: '2026-09-14T10:00:05+02:00',
    ...overrides,
  }
}
