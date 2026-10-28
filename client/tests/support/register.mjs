// node:test 跑前端纯逻辑（无新依赖）：Node 22 自带类型擦除，这里只补两件 Vite 会做的事——
// ① 相对导入省略扩展名时补 .ts；② 导入 .json 时不要求 import attributes。
// 时间格式的断言以 UTC 为准，与运行机器所在时区无关（Windows 上同样适用）。
import { register } from 'node:module'

process.env.TZ = 'UTC'
register('./hooks.mjs', import.meta.url)
