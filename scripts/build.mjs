import { readFile, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'

await rm('lib', { recursive: true, force: true })

const rootNames = ts.sys.readDirectory('src', ['.ts'])
const program = ts.createProgram({
  rootNames,
  options: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: 'lib/types',
    rootDir: 'src',
  },
})
const emit = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics)
if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
  process.exit(1)
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'cordis'],
})

// Client bundle (browser): the web shell serves it at /plugins/<id>/client.js.
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: 'lib/client.js',
  external: ['react', 'react-dom', '@deepseek-ai/*'],
})

const source = await readFile('lib/index.js', 'utf8')
await writeFile('lib/index.js', source.replace(/[ \t]+$/gm, ''))
const clientSource = await readFile('lib/client.js', 'utf8')
await writeFile('lib/client.js', clientSource.replace(/[ \t]+$/gm, ''))

console.log('[dsh-graphflow] built Host + Client bundles')
