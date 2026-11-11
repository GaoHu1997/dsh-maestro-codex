/** Per-tool path binding for the Native file bridge; never mutates the parent Session. */
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type PathShape = 'file' | 'root' | 'files' | 'pair'
/** Match the published Native schemas, not guessed aliases or arbitrary nested strings. */
const PATH_SHAPES: Readonly<Record<string, PathShape>> = {
  ops_read_files: 'files',
  ops_inspect_local_file: 'file',
  ops_glob: 'root',
  ops_grep: 'root',
  ops_stat: 'file',
  ops_diff: 'file',
  ops_edit_file: 'file',
  ops_write_file: 'file',
  ops_replace: 'root',
  ops_copy: 'pair',
  ops_move: 'pair',
  ops_remove: 'file',
}
export const SCOPED_FS_TOOLS: readonly string[] = Object.freeze(Object.keys(PATH_SHAPES))

export type ScopedToolArguments =
  | { readonly ok: true; readonly arguments: Record<string, unknown> }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string }

class ScopedPathError extends Error {
  constructor(readonly status: 400 | 403, message: string) { super(message) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function within(root: string, target: string): boolean {
  const rest = relative(root, target)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

/** Only absent components may fall back to an ancestor; access errors/links fail closed. */
async function realResolve(target: string): Promise<string> {
  let current = target
  const tail: string[] = []
  for (;;) {
    try { return join(await realpath(current), ...tail) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling link is present, not a not-yet-created regular path.
      try {
        await lstat(current)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
        const parent = dirname(current)
        if (parent === current) throw error
        tail.unshift(basename(current))
        current = parent
        continue
      }
      throw error
    }
  }
}

/**
 * Bind *all* tool path slots (including search defaults) to an absolute task path.
 * Keep the lexical absolute path after checking realpath containment: replacing
 * a link with its target would hide it from the host's no-follow policy.
 * Host guards, revision checks and race-resistant filesystem operations still apply.
 */
export async function prepareScopedToolArguments(name: string, args: unknown, cwd: string | undefined): Promise<ScopedToolArguments> {
  if (!SCOPED_FS_TOOLS.includes(name)) return { ok: false, status: 403, error: `工具 ${name} 不在 scoped 文件工具名单中` }
  if (cwd === undefined || cwd.trim() === '' || !isAbsolute(cwd)) {
    return { ok: false, status: 403, error: 'scoped 文件工具需要绑定的绝对任务目录（cwd）' }
  }
  if (!isRecord(args)) return { ok: false, status: 400, error: 'scoped 文件工具参数必须是对象' }
  const root = resolve(cwd)
  try {
    const realRoot = await realpath(root)
    if (!(await stat(realRoot)).isDirectory()) throw new ScopedPathError(403, 'scoped 任务 cwd 必须是已存在的目录')
    const bind = async (value: unknown, field: string, defaultRoot = false): Promise<string> => {
      const raw = value === undefined && defaultRoot ? '.' : value
      if (typeof raw !== 'string' || raw.trim() === '' || raw.includes(String.fromCharCode(0))) {
        throw new ScopedPathError(400, `scoped 文件工具参数 ${field} 必须是非空路径`)
      }
      // Drive-relative paths depend on process per-drive cwd, not the task cwd.
      if (process.platform === 'win32' && /^[a-z]:(?:$|[^\\/])/i.test(raw)) {
        throw new ScopedPathError(400, `scoped 文件工具参数 ${field} 不允许盘符相对路径`)
      }
      const absolute = resolve(root, raw)
      if (!within(root, absolute) || !within(realRoot, await realResolve(absolute))) {
        throw new ScopedPathError(403, `路径 ${raw} 不在本次任务目录 ${cwd} 内，scoped 模式已拒绝`)
      }
      return absolute
    }
    const bound = { ...args }
    switch (PATH_SHAPES[name]) {
      case 'files': {
        const files = args['files']
        if (!Array.isArray(files) || files.length < 1 || files.length > 32) {
          throw new ScopedPathError(400, 'ops_read_files.files 必须包含 1–32 个文件范围')
        }
        const ranges: Record<string, unknown>[] = []
        for (const file of files) {
          if (!isRecord(file)) throw new ScopedPathError(400, 'ops_read_files.files 的每项必须是对象')
          ranges.push({ ...file, path: await bind(file['path'], 'files[].path') })
        }
        bound['files'] = ranges
        break
      }
      case 'pair':
        bound['path'] = await bind(args['path'], 'path')
        bound['to'] = await bind(args['to'], 'to')
        break
      case 'root':
        bound['path'] = await bind(args['path'], 'path', true)
        break
      case 'file':
        bound['path'] = await bind(args['path'], 'path')
        break
      default:
        throw new ScopedPathError(403, 'scoped 文件工具缺少路径适配器')
    }
    return { ok: true, arguments: bound }
  } catch (error) {
    return error instanceof ScopedPathError
      ? { ok: false, status: error.status, error: error.message }
      : { ok: false, status: 403, error: 'scoped 无法确认任务目录或目标路径边界，已拒绝调用' }
  }
}

/** Compatibility helper for callers needing only the refusal text. */
export async function scopedPathViolation(name: string, args: unknown, cwd: string | undefined): Promise<string | undefined> {
  const result = await prepareScopedToolArguments(name, args, cwd)
  return result.ok ? undefined : result.error
}
