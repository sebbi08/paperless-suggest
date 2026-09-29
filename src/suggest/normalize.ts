export interface NamedEntity {
  id: number
  name: string
}

export interface NearMatch {
  id: number
  name: string
  score: number
}

const LEGAL_SUFFIXES = new Set([
  'ag', 'gmbh', 'mbh', 'co', 'kg', 'ohg', 'se', 'ug', 'ev',
  'inc', 'ltd', 'llc', 'plc', 'corp', 'sa', 'bv',
])

export function normalizeName(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
  const tokens = folded.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const kept = tokens.filter((t) => !LEGAL_SUFFIXES.has(t))
  return (kept.length > 0 ? kept : tokens).join(' ')
}

function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/ /g, '')
  const out = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

function dice(a: string, b: string): number {
  const ga = bigrams(a)
  const gb = bigrams(b)
  let total = 0
  for (const n of ga.values()) total += n
  for (const n of gb.values()) total += n
  if (total === 0) return a === b ? 1 : 0
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0)
  return (2 * overlap) / total
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = na.split(' ')
  const tb = nb.split(' ')
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.join('').length >= 4 && short.every((t) => long.includes(t))) return 0.9
  return dice(na, nb)
}

export function rankMatches(name: string, candidates: NamedEntity[], limit = 3): NearMatch[] {
  return candidates
    .map((c) => ({ id: c.id, name: c.name, score: nameSimilarity(name, c.name) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}
