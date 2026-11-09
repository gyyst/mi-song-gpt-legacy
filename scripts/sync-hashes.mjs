/**
 * 构建后同步哈希：builder 会把 entryHash / zipHash 写入 dist/_build/plugin.json，
 * 但不会回写项目根目录的 plugin.json。这里只同步这两个字段，保证安装/更新时
 * 清单里的哈希与实际产物一致。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const builtPath = resolve(root, 'dist/_build/plugin.json')
const rootPath = resolve(root, 'plugin.json')

const built = JSON.parse(readFileSync(builtPath, 'utf8'))
const manifest = JSON.parse(readFileSync(rootPath, 'utf8'))

manifest.main = built.main
manifest.entryHash = built.entryHash
manifest.zipHash = built.zipHash

writeFileSync(rootPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`  🔑 plugin.json hashes synced (${String(built.entryHash).slice(0, 12)}…)`)
