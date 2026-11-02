#!/usr/bin/env node
/**
 * `maestro status` —— 一屏看清「现在需不需要我」。
 *
 * 只读：读本插件的 `/plugin/dsh-maestro-codex/status` 路由，不写任何状态。
 * 用法：
 *   node scripts/maestro-status.mjs [--url http://127.0.0.1:11061] [--json]
 * 环境变量：MAESTRO_WEB_URL（--url 优先）
 * 退出码：0 = 一切正常；1 = 连不上/响应不对；2 = 有健康问题需要看
 */

const DEFAULT_URL = 'http://127.0.0.1:11061'
const TIMEOUT_MS = 5000

function parseArgs(argv) {
  const options = { url: process.env.MAESTRO_WEB_URL?.trim() || DEFAULT_URL, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--url') {
      const next = argv[index + 1]
      if (typeof next === 'string' && next.trim() !== '') {
        options.url = next.trim()
        index += 1
      }
    } else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const HELP = `maestro status —— dsh-maestro-codex 的一屏状态

用法：node scripts/maestro-status.mjs [--url <web 地址>] [--json]

  --url   宿主 Web 地址，默认 ${DEFAULT_URL}（也可用环境变量 MAESTRO_WEB_URL）
  --json  原样输出路由返回的 JSON
  --help  显示这段说明
`

/** 把 status 路由的响应渲染成人话。纯函数，方便将来搬去做测试。 */
export function renderStatus(body) {
  const counts = body.tasks ?? {}
  const lines = []
  const running = counts.working ?? 0
  const queued = counts['working/queued'] ?? 0
  const waiting = body.needsPerson ?? 0
  lines.push(`maestro：${String(running)} 个在跑，${String(queued)} 个排队，${String(waiting)} 个在等人`)
  const person = [
    ['person/answer', '等你回话'],
    ['person/review', '等你验收'],
    ['person/blocked', '等你处理阻塞'],
    ['person/failed', '等你决定重试'],
  ]
  if (waiting > 0) lines.push(`  人这边：${person.map(([key, label]) => `${label} ${String(counts[key] ?? 0)}`).join(' · ')}`)
  const problems = Array.isArray(body.problems) ? body.problems : []
  if (problems.length === 0) lines.push('  健康：正常')
  else {
    lines.push(`  健康：${String(problems.length)} 条问题`)
    for (const problem of problems) lines.push(`    - ${problem.name}（${problem.level}）：${problem.message || '没有说明'}`)
  }
  const pending = body.pendingEffects ?? 0
  if (pending > 0) lines.push(`  未结清的副作用行：${String(pending)}（下次启动会标成 interrupted）`)
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  const base = options.url.replace(/\/+$/, '')
  const url = `${base}/plugin/dsh-maestro-codex/status`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    process.stderr.write(`连不上 ${url}：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (!response.ok) {
    process.stderr.write(`${url} 返回 HTTP ${String(response.status)}\n`)
    return 1
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    process.stderr.write(`${url} 返回的不是 JSON：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (options.json) process.stdout.write(`${JSON.stringify(body, undefined, 2)}\n`)
  else process.stdout.write(`${renderStatus(body)}\n`)
  return Array.isArray(body.problems) && body.problems.length > 0 ? 2 : 0
}

const isDirectRun = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('maestro-status.mjs') === true
if (isDirectRun) process.exitCode = await main()
