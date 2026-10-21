export interface PaperlessDocument {
  id: number
  title: string
  content: string
  correspondent: number | null
  tags: number[]
  /** Issue date ("Ausstellungsdatum") as YYYY-MM-DD */
  created: string
  added: string
  modified: string
}

export interface PaperlessTag {
  id: number
  name: string
  isInboxTag: boolean
  documentCount: number
}

export interface PaperlessCorrespondent {
  id: number
  name: string
  documentCount: number
}

export interface DocumentPatch {
  title?: string
  correspondent?: number | null
  tags?: number[]
  /** YYYY-MM-DD */
  created?: string
}

/** Current tags (including the inbox tag) and correspondents. */
export interface Vocabulary {
  inboxTagId: number
  tags: PaperlessTag[]
  correspondents: PaperlessCorrespondent[]
}
