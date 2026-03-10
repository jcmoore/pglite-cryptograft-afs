import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(new URL('../..', import.meta.url).pathname)
const latestDir = path.join(rootDir, 'bench', 'results', 'latest')
const baselinesDir = path.join(rootDir, 'bench', 'baselines')
const reportPath = path.join(rootDir, 'bench', 'results', 'latest', 'comparison.md')

fs.mkdirSync(latestDir, { recursive: true })
fs.mkdirSync(baselinesDir, { recursive: true })

const latest = loadDirectory(latestDir)
const baseline = loadDirectory(baselinesDir)

const lines = ['# Benchmark Comparison', '', `Generated: ${new Date().toISOString()}`, '']

if (latest.length === 0) {
  lines.push('No benchmark JSON files were found in `bench/results/latest`.')
} else {
  for (const latestEntry of latest) {
    const baseEntry = baseline.find((entry) => entry.name === latestEntry.name)
    lines.push(`## ${latestEntry.name}`)
    if (!baseEntry) {
      lines.push('No baseline available.')
      lines.push('')
      continue
    }

    const latestMean = latestEntry.value.mean ?? 0
    const baseMean = baseEntry.value.mean ?? 0
    const delta = latestMean - baseMean
    const deltaPct = baseMean === 0 ? 0 : (delta / baseMean) * 100
    lines.push(`- Baseline mean: ${baseMean}`)
    lines.push(`- Latest mean: ${latestMean}`)
    lines.push(`- Delta: ${delta} (${deltaPct.toFixed(2)}%)`)
    lines.push('')
  }
}

fs.writeFileSync(reportPath, lines.join('\n'))
console.log(`Wrote ${path.relative(rootDir, reportPath)}`)

function loadDirectory(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      value: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    }))
}
