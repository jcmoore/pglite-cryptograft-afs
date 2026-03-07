import * as fs from 'node:fs'
import * as path from 'node:path'

interface BenchmarkResult {
  name: string
  rank: number
  mean: number
  hz: number
  rme: number
  sampleCount: number
}

interface GroupResult {
  fullName: string
  benchmarks: BenchmarkResult[]
}

interface FileResult {
  groups: GroupResult[]
}

interface VitestBenchJson {
  files: FileResult[]
}

interface Row {
  pageKb: number
  workload: string
  contender: string
  meanMs: number
  hz: number
  rank: number
  vsPlain: number
  rme: number
  samples: number
}

function parsePageKb(fileName: string): number {
  const match = /page(\d+)k/i.exec(fileName)
  if (!match) {
    throw new Error(`Could not infer page size from filename: ${fileName}`)
  }
  return Number.parseInt(match[1], 10)
}

function formatNum(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : ''
}

function main(): void {
  const resultDir = process.argv[2]
  if (!resultDir) {
    throw new Error('Usage: bun scripts/bench-matrix-markdown.ts <json-dir>')
  }

  const files = fs
    .readdirSync(resultDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((a, b) => parsePageKb(a) - parsePageKb(b))

  if (files.length === 0) {
    throw new Error(`No benchmark JSON files found in ${resultDir}`)
  }

  const rows: Row[] = []
  for (const fileName of files) {
    const pageKb = parsePageKb(fileName)
    const fullPath = path.join(resultDir, fileName)
    const payload = JSON.parse(
      fs.readFileSync(fullPath, 'utf8'),
    ) as VitestBenchJson

    for (const file of payload.files) {
      for (const group of file.groups) {
        const workload = group.fullName.includes('bulk insert')
          ? 'bulk_insert_1000'
          : group.fullName.includes('matrix select')
            ? 'select_1000'
            : group.fullName

        const plain = group.benchmarks.find((bm) =>
          bm.name.startsWith('plain-nodefs'),
        )
        const plainMean = plain?.mean ?? Number.NaN

        for (const bm of group.benchmarks) {
          rows.push({
            pageKb,
            workload,
            contender: bm.name,
            meanMs: bm.mean,
            hz: bm.hz,
            rank: bm.rank,
            vsPlain: Number.isFinite(plainMean) ? bm.mean / plainMean : Number.NaN,
            rme: bm.rme,
            samples: bm.sampleCount,
          })
        }
      }
    }
  }

  const header = [
    '| page_kb | workload | contender | mean_ms | hz | rank | vs_plain_x | rme_pct | samples |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  const lines = rows.map((row) =>
    [
      `| ${row.pageKb}`,
      `${row.workload}`,
      `${row.contender}`,
      `${formatNum(row.meanMs, 4)}`,
      `${formatNum(row.hz, 2)}`,
      `${row.rank}`,
      `${formatNum(row.vsPlain, 3)}`,
      `${formatNum(row.rme, 2)}`,
      `${row.samples} |`,
    ].join(' | '),
  )

  console.log([...header, ...lines].join('\n'))
}

main()
