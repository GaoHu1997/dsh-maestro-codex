import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { generateUpstreamCss } from './build-upstream-css.mjs'

await generateUpstreamCss()
const configFile = fileURLToPath(new URL('../tsconfig.upstream.json', import.meta.url))
const config = ts.readConfigFile(configFile, ts.sys.readFile)
if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile))
const host = ts.createCompilerHost(parsed.options)
host.writeFile = (filename, contents) => {
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, contents)
}
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else {
  const emitted = program.emit()
  if (emitted.emitSkipped) process.exitCode = 1
  else process.stdout.write('Generated upstream CSS Modules and original API declarations.\n')
}
