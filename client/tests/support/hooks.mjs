import { readFile } from 'node:fs/promises'

const RELATIVE = /^\.{1,2}\//

export async function resolve(specifier, context, nextResolve) {
  if (RELATIVE.test(specifier) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        // 试下一个
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const source = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: `export default ${source};`, shortCircuit: true }
  }
  return nextLoad(url, context)
}
