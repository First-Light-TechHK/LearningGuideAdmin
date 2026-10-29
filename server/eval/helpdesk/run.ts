import { runCli } from './cli';

/** npm run eval:helpdesk 的入口：参数与退出码见 cli.ts（测试在 eval.spec.ts）。 */
void runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  log: (line) => console.log(line),
}).then((code) => {
  process.exitCode = code;
});
