import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import process from 'node:process'

/**
 * 非数据源文件的行数上限。
 *
 * 约束的是「要读懂才能改」的逻辑量，所以 `.vue` 只统计 `<script>` 块：一段长模板
 * 和一段长逻辑不是同一种负担，把模板算进来只会逼人把模板挪到 SFC 外面——而
 * `vue-tsc` 不解析 `<template src>`，那样等于用类型检查换行数。
 */
const SOURCE_ROOT = join(process.cwd(), 'src')
const MAX_LINES = 600
const SOURCE_EXTENSIONS = new Set(['.ts', '.vue'])
const EXCLUDED_DATA_FILES = new Set([
  'src/utils/iconify.icons.ts',
  'src/utils/regionData.ts',
])
const VUE_SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script>/gu

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

function lineCount(source: string): number {
  if (!source)
    return 0
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0)
}

/** `.vue` 只算脚本块，其余文件整篇算。 */
function countLines(path: string): number {
  const source = readFileSync(path, 'utf8')
  if (extname(path) !== '.vue')
    return lineCount(source)
  return [...source.matchAll(VUE_SCRIPT_BLOCK_PATTERN)]
    .reduce((total, match) => total + lineCount(match[1]!.replace(/^\n/u, '').replace(/\n$/u, '')), 0)
}

const oversized = listFiles(SOURCE_ROOT)
  .filter(path => SOURCE_EXTENSIONS.has(extname(path)))
  .map(path => ({ path: relative(process.cwd(), path), lines: countLines(path) }))
  .filter(file => !EXCLUDED_DATA_FILES.has(file.path) && file.lines > MAX_LINES)
  .sort((left, right) => right.lines - left.lines)

if (oversized.length) {
  console.error(`Source size audit failed: non-data source files must stay at or below ${MAX_LINES} lines (\`.vue\` counts its <script> blocks only).`)
  for (const file of oversized)
    console.error(`- ${file.path}: ${file.lines}`)
  process.exit(1)
}

console.log(`Source size audit passed: every non-data source file is at or below ${MAX_LINES} lines.`)
console.log(`\`.vue\` files count their <script> blocks only; excluded data files: ${[...EXCLUDED_DATA_FILES].join(', ')}`)
