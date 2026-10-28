// node:test 跑前端纯逻辑与组件：Node 22 自带类型擦除，这里补几件 Vite 会做的事——
// ① 相对导入省略扩展名时补 .ts / .tsx；② 导入 .json 时不要求 import attributes；
// ③ .tsx 用 Vite 自带的 Oxc 转 JSX；④ 导入 .css 时给空模块。
// 组件测试（*.test.tsx）第一行 import './support/dom' 装上 jsdom。
// 时间格式的断言以 UTC 为准，与运行机器所在时区无关（Windows 上同样适用）。
import { register } from 'node:module'

process.env.TZ = 'UTC'
register('./hooks.mjs', import.meta.url)
