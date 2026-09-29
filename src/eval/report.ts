import type { ModelSummary, TitleChecks } from './metrics'

export interface ReportCell {
  title: string | null
  correspondent: string | null
  tags: string[]
  proposed: string[]
  error: string | null
  seconds: number
  checks: TitleChecks | null
}

export interface ReportRow {
  documentId: number
  truth: { title: string; correspondent: string; tags: string[] }
  byModel: Record<string, ReportCell>
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function cell(c: ReportCell | undefined): string {
  if (!c) return '<td></td>'
  if (c.error) return `<td class="err">${esc(c.error)}</td>`
  const failed = c.checks ? Object.entries(c.checks).filter(([, ok]) => !ok).map(([k]) => k.replace(/Ok$/, '?')) : []
  return `<td><b>${esc(c.title ?? '')}</b>${failed.length ? ` <span class="warn">${failed.join(' ')}</span>` : ''}
<br>${esc(c.correspondent ?? '—')}<br>${c.tags.map(esc).join(', ')}${c.proposed.map((p) => ` <span class="new">NEW: ${esc(p)}</span>`).join('')}
<br><small>${c.seconds.toFixed(1)} s</small></td>`
}

export function renderReport(input: { generatedAt: string; summaries: ModelSummary[]; rows: ReportRow[] }): string {
  const models = input.summaries.map((s) => s.model)
  const summaryRows = input.summaries
    .map(
      (s) =>
        `<tr><td>${esc(s.model)}</td><td>${s.documents}</td><td>${pct(s.correspondentAccuracy)}</td><td>${pct(s.tagPrecision)}</td><td>${pct(s.tagRecall)}</td><td>${pct(s.tagF1)}</td><td>${pct(s.newNameRate)}</td><td>${pct(s.failureRate)}</td><td>${pct(s.titleChecksPassRate)}</td><td>${s.avgSeconds.toFixed(1)} s</td></tr>`,
    )
    .join('\n')
  const detailRows = input.rows
    .map(
      (r) =>
        `<tr><td>#${r.documentId}<br><b>${esc(r.truth.title)}</b><br>${esc(r.truth.correspondent)}<br>${r.truth.tags.map(esc).join(', ')}</td>${models.map((m) => cell(r.byModel[m])).join('')}</tr>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Paperless Suggest eval ${esc(input.generatedAt)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;margin-bottom:32px}
td,th{border:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f5f5f5}
.err{color:#b91c1c}.warn{color:#b45309;font-size:12px}.new{color:#b45309;border:1px dashed #b45309;border-radius:8px;padding:0 4px;font-size:12px}
</style></head><body>
<h1>Model evaluation</h1><p>Generated ${esc(input.generatedAt)}</p>
<h2>Summary</h2>
<table><tr><th>Model</th><th>Docs</th><th>Correspondent acc.</th><th>Tag precision</th><th>Tag recall</th><th>Tag F1</th><th>New-name rate</th><th>Failures</th><th>Title checks</th><th>Avg time</th></tr>
${summaryRows}
</table>
<h2>Per document</h2>
<table><tr><th>Ground truth</th>${models.map((m) => `<th>${esc(m)}</th>`).join('')}</tr>
${detailRows}
</table>
</body></html>
`
}
