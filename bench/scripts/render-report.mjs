import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(new URL('../..', import.meta.url).pathname)
const latestDir = path.join(rootDir, 'bench', 'results', 'latest')
const reportDir = path.join(rootDir, 'bench', 'results', 'latest')
const htmlPath = path.join(reportDir, 'report.html')

fs.mkdirSync(reportDir, { recursive: true })

const entries = loadEntries(latestDir)

const rows = entries
  .map(
    (entry) => `<tr><td>${escapeHtml(entry.name)}</td><td>${entry.mean}</td><td>${entry.min}</td><td>${entry.max}</td></tr>`,
  )
  .join('\n')

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Benchmark Report</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
      th { background: #f4f4f4; }
    </style>
  </head>
  <body>
    <h1>Benchmark Report</h1>
    <p>Generated: ${new Date().toISOString()}</p>
    <table>
      <thead>
        <tr>
          <th>Benchmark</th>
          <th>Mean</th>
          <th>Min</th>
          <th>Max</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="4">No benchmark JSON files found.</td></tr>'}
      </tbody>
    </table>
  </body>
</html>`

fs.writeFileSync(htmlPath, html)
console.log(`Wrote ${path.relative(rootDir, htmlPath)}`)

function loadEntries(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      return {
        name,
        max: value.max ?? 0,
        mean: value.mean ?? 0,
        min: value.min ?? 0,
      }
    })
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return char
    }
  })
}
