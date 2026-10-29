import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const RELATIVE = /^\.{1,2}\//

export async function resolve(specifier, context, nextResolve) {
  if (RELATIVE.test(specifier) && !/\.[cm]?[jt]sx?$|\.json$|\.css$/.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        // 试下一个
      }
    }
  }
  return nextResolve(specifier, context)
}

let transformWithOxc = null

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const source = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: `export default ${source};`, shortCircuit: true }
  }
  // 样式由浏览器处理：组件测试只看结构与行为
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true }
  }
  // Node 的类型擦除不支持 JSX：.tsx 用 Vite 自带的 Oxc 转换（与构建同一套编译器）
  if (url.startsWith('file:') && url.endsWith('.tsx')) {
    transformWithOxc ??= (await import('vite')).transformWithOxc
    const filename = fileURLToPath(url)
    const source = await readFile(filename, 'utf8')
    const result = await transformWithOxc(source, filename, {
      lang: 'tsx',
      sourcemap: true,
      jsx: { runtime: 'automatic', development: false },
    })
    const map = result.map ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')}` : ''
    return { format: 'module', source: result.code + map, shortCircuit: true }
  }
  return nextLoad(url, context)
}
