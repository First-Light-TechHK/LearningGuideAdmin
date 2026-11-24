// Provision the independent Admin stack (DEV and Sandbox): logical RDS database, Secrets, App Runner.
// Required env: VPC_ID, SUBNET_IDS (comma separated), SECURITY_GROUP_ID, GITHUB_CONNECTION_ARN,
//               INSTANCE_ROLE_ARN, VPC_CONNECTOR_ARN
// Optional: DB_INSTANCE_CLASS (default db.t4g.micro), REGION (default ap-southeast-1),
//           ADMIN_BRANCH (default dev; REQUIRED for ADMIN_ENV=sandbox),
//           AUTH_ENABLED (default false; REQUIRED true for ADMIN_ENV=sandbox),
//           COURSE_MEDIA_BUCKET / COURSE_PACKAGE_BUCKET (Sandbox 桶由 ops 预建，脚本不自建桶)
// Operator-only. Never prints secret values. Run without --apply for a dry run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { assertSecretArn } from "./apprunner-env.mjs";

const region = process.env.REGION || "ap-southeast-1";
const apply = process.argv.includes("--apply");
// The same script provisions dev, sit, uat and sandbox; ADMIN_ENV selects the names.
// Defaults to dev so the original DEV documentation and command stay valid.
const environment = (process.env.ADMIN_ENV || "dev").toLowerCase();
if (!["dev", "sit", "uat", "sandbox"].includes(environment)) throw new Error("ADMIN_ENV must be dev, sit, uat or sandbox");
const dbSuffix = environment.replace(/-/g, "_");
const required = ["VPC_ID", "SUBNET_IDS", "SECURITY_GROUP_ID", "GITHUB_CONNECTION_ARN", "INSTANCE_ROLE_ARN", "VPC_CONNECTOR_ARN"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const repositoryUrl = process.env.REPOSITORY_URL || "https://github.com/First-Light-TechHK/LearningGuideAdmin";
// dev/sit/uat keep the historical dev default. Sandbox has no safe default branch:
// the sandbox branch must be a fast-forward of the latest production release SHA
// (UAT = current production, same code; fixes merged into upstream dev enter sandbox
// only with the next production release) and is passed explicitly, so the service can
// never be accidentally pointed at dev/feature code (deployment gate, see
// docs/sandbox/environments.md §3 / partitioning.md §6).
const branch = process.env.ADMIN_BRANCH || (environment === "sandbox" ? null : "dev");
if (!branch) throw new Error("ADMIN_BRANCH is required when ADMIN_ENV=sandbox (sandbox 分支 = 上游最近一次生产发布 SHA 快进)");
// Sandbox carries real end-user test traffic: it must never run without API-key auth.
if (environment === "sandbox" && process.env.AUTH_ENABLED !== "true") {
  throw new Error("AUTH_ENABLED=true is required when ADMIN_ENV=sandbox");
}

function aws(service, operation, input = {}) {
  const args = [service, operation, "--region", region, "--output", "json"];
  if (Object.keys(input).length) args.push("--cli-input-json", JSON.stringify(input));
  return JSON.parse(execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "{}");
}
function optional(service, operation, input) {
  try { return aws(service, operation, input); }
  catch (error) { if (/ResourceNotFound|NoSuchEntity|DBInstanceNotFound|DBSubnetGroupNotFound/i.test(String(error.stderr))) return null; throw error; }
}

// Sandbox 环境缺省（owner 2026-11-24：不再做能力/角色分区）：不写 APP_ROLES 与
// ADMIN_CAPABILITIES，服务端按“未设置 = 全开”启动全部角色与全部模块（见
// server/src/app-roles.ts、server/src/common/capabilities.ts）。只显式写死
// Sandbox 的环境标识与版本编号语义，避免依赖编号模式的静默推导。
// dev/sit/uat 保持历史行为（这两项也不写）。
const sandboxEnvironmentDefaults = {
  ENVIRONMENT_LABEL: "Sandbox",
  VERSION_NUMBERING_MODE: "sandbox"
};

const plan = { region, environment, apply, steps: [] };
// dry run 也展示 sandbox 缺省变量，便于 ops 在 --apply 前核对（不调用 AWS）。
if (environment === "sandbox") plan.runtimeEnvironmentDefaults = sandboxEnvironmentDefaults;
const dbId = `learning-guide-admin-${environment}`;
const serviceName = `learning-guide-admin-${environment}`;
const dbName = `learning_guide_admin_${dbSuffix}`;
const dbUser = `lg_admin_${dbSuffix}`;
const dbPassword = randomBytes(24).toString("hex");
// Course media/package storage. DEV/SIT/UAT keep the shared Admin course bucket
// (existing deployments); Sandbox uses its own -sandbox- namespaced bucket that
// ops creates beforehand (this script never creates buckets or runtime roles).
// Explicit COURSE_MEDIA_BUCKET / COURSE_PACKAGE_BUCKET always win.
const bucketAccount = process.env.AWS_ACCOUNT_ID || "851987565851";
const courseMediaBucket =
  process.env.COURSE_MEDIA_BUCKET ||
  (environment === "sandbox"
    ? `learning-guide-admin-sandbox-course-${bucketAccount}`
    : "learning-guide-admin-dev-course-851987565851");
const coursePackageBucket =
  process.env.COURSE_PACKAGE_BUCKET || courseMediaBucket;

if (!apply) {
  plan.steps.push("create db subnet group", "create RDS instance", "create secrets", "create App Runner service");
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

// 1) DB subnet group
const groups = optional("rds", "describe-db-subnet-groups", { DBSubnetGroupName: dbId });
if (!groups?.DBSubnetGroups?.length) {
  aws("rds", "create-db-subnet-group", {
    DBSubnetGroupName: dbId,
    DBSubnetGroupDescription: `Learning Guide admin ${environment.toUpperCase()}`,
    SubnetIds: process.env.SUBNET_IDS.split(",").map((value) => value.trim()),
    Tags: [{ Key: "Environment", Value: environment.toUpperCase() }, { Key: "Project", Value: "LearningGuide" }]
  });
}

// 2) RDS instance (PostgreSQL, private)
if (!optional("rds", "describe-db-instances", { DBInstanceIdentifier: dbId })) {
  aws("rds", "create-db-instance", {
    DBInstanceIdentifier: dbId,
    DBInstanceClass: process.env.DB_INSTANCE_CLASS || "db.t4g.micro",
    Engine: "postgres",
    // Keep every admin engine on the same minor line as its Portal environment.
    EngineVersion: process.env.DB_ENGINE_VERSION || "16.13",
    AllocatedStorage: 20,
    DBName: dbName,
    MasterUsername: dbUser,
    MasterUserPassword: dbPassword,
    VpcSecurityGroupIds: [process.env.SECURITY_GROUP_ID],
    DBSubnetGroupName: dbId,
    PubliclyAccessible: false,
    // Sandbox 是唯一的内容写入环境（其它环境内容按生产流程导入），误删恢复窗口
    // 按部署约定用 7 天（readiness G12）；dev/sit/uat 保持历史默认 1 天。
    BackupRetentionPeriod: environment === "sandbox" ? 7 : 1,
    StorageEncrypted: true,
    Tags: [{ Key: "Environment", Value: environment.toUpperCase() }, { Key: "Project", Value: "LearningGuide" }]
  });
}

for (let i = 0; i < 90; i++) {
  const instance = aws("rds", "describe-db-instances", { DBInstanceIdentifier: dbId }).DBInstances[0];
  if (instance.DBInstanceStatus === "available") break;
  await new Promise((resolve) => setTimeout(resolve, 20000));
}

const instance = aws("rds", "describe-db-instances", { DBInstanceIdentifier: dbId }).DBInstances[0];
if (instance.DBInstanceStatus !== "available") throw new Error(`RDS is ${instance.DBInstanceStatus}`);

// 3) Secrets
const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${instance.Endpoint.Address}:${instance.Endpoint.Port}/${dbName}`;
// The secret keeps the admin_api_key NAME (pairing documents and the Portal-side
// ADMIN_PORTAL_API_TOKEN / KS_TUTOR_API_KEY reference it), but the service reads
// the variable AUTH_TOKEN — the mapping happens in RuntimeEnvironmentSecrets below.
const secrets = { DATABASE_URL: databaseUrl, ADMIN_API_KEY: randomBytes(32).toString("hex") };
const secretArns = {};
for (const [key, value] of Object.entries(secrets)) {
  const Name = `learning-guide/admin/${environment}/${key.toLowerCase()}`;
  const existing = optional("secretsmanager", "describe-secret", { SecretId: Name });
  secretArns[key] = existing
    ? existing.ARN
    : aws("secretsmanager", "create-secret", { Name, SecretString: value, Tags: [{ Key: "Environment", Value: environment.toUpperCase() }] }).ARN;
}

// 4) App Runner service
const service = optional("apprunner", "describe-service", { ServiceArn: `arn:aws:apprunner:${region}:${process.env.AWS_ACCOUNT_ID}:service/${serviceName}/placeholder` });
const existing = aws("apprunner", "list-services", {}).ServiceSummaryList.find((item) => item.ServiceName === serviceName);
const source = {
  // Source-based deployment: App Runner builds and deploys on every push, like
  // the Portal services. No local image build.
  // Sandbox 例外：发布只允许走 deploy/admin-sandbox-deploy.yml.template
  // （复制为 .github/workflows/sandbox-deploy.yml，先等 CI 再 start-deployment），
  // 关闭分支自动部署让工作流成为唯一发布者，与 docs/sandbox/environments.md §3 一致。
  AutoDeploymentsEnabled: environment !== "sandbox",
  AuthenticationConfiguration: { ConnectionArn: process.env.GITHUB_CONNECTION_ARN },
  CodeRepository: {
    RepositoryUrl: repositoryUrl,
    SourceCodeVersion: { Type: "BRANCH", Value: branch },
    CodeConfiguration: {
      ConfigurationSource: "API",
      CodeConfigurationValues: {
        Runtime: "NODEJS_22",
        BuildCommand: "cd server && npm ci && npx prisma generate && npm run build && cd ../client && npm ci && npm run build",
        // StartCommand is not a shell: keep the operators inside the script.
        StartCommand: "sh ./start-admin.sh",
        Port: "3000",
        RuntimeEnvironmentVariables: {
          NODE_ENV: "production",
          APP_ENV: environment.toUpperCase(),
          PORT: "3000",
          AWS_REGION: region,
          // 服务鉴权：显式写入，不再依赖服务缺省。Sandbox 必为 true（脚本已校验）；
          // dev/sit/uat 缺省 false，与历史部署行为一致。
          AUTH_ENABLED: process.env.AUTH_ENABLED || "false",
          // Sandbox 环境缺省见文件顶部 sandboxEnvironmentDefaults（能力/角色全开）；
          // dev/sit/uat 不写，保持历史行为。
          ...(environment === "sandbox" ? sandboxEnvironmentDefaults : {}),
          // Course media/package storage. DEV uses a dedicated Admin course bucket;
          // media keys stay at the bucket root, package staging under staging/.
          // Sandbox uses the -sandbox- namespaced bucket (see top of file).
          COURSE_MEDIA_BUCKET: courseMediaBucket,
          COURSE_PACKAGE_BUCKET: coursePackageBucket,
          COURSE_PACKAGE_PREFIX: "staging/",
          ...(process.env.AI_AVAILABLE_MODELS ? { AI_AVAILABLE_MODELS: process.env.AI_AVAILABLE_MODELS } : {}),
          // Mail: SMTP wins when fully configured, otherwise SES v2 with this sender.
          // SES starts in the sandbox; production access must be requested in AWS.
          ...(process.env.SES_FROM_EMAIL ? { SES_FROM_EMAIL: process.env.SES_FROM_EMAIL } : {}),
          ...(process.env.SMTP_HOST ? { SMTP_HOST: process.env.SMTP_HOST } : {}),
          ...(process.env.SMTP_PORT ? { SMTP_PORT: process.env.SMTP_PORT } : {}),
          ...(process.env.SMTP_SECURE ? { SMTP_SECURE: process.env.SMTP_SECURE } : {}),
          ...(process.env.SMTP_USER ? { SMTP_USER: process.env.SMTP_USER } : {}),
          ...(process.env.SMTP_FROM ? { SMTP_FROM: process.env.SMTP_FROM } : {})
        },
        RuntimeEnvironmentSecrets: {
          DATABASE_URL: secretArns.DATABASE_URL,
          // The service reads AUTH_TOKEN (api-key.guard.ts); map it to the
          // admin_api_key secret ARN instead of injecting the unread ADMIN_API_KEY.
          AUTH_TOKEN: secretArns.ADMIN_API_KEY,
          // The tutor needs a real LLM key, and course-level keys are encrypted.
          // Pre-create these secrets and pass their ARNs; never pass values.
          // Re-running without them drops the keys until the next deploy merges
          // them back (configure-admin-dev-env.mjs).
          ...(process.env.OPENROUTER_API_KEY_SECRET_ARN ? { OPENROUTER_API_KEY: assertSecretArn(process.env.OPENROUTER_API_KEY_SECRET_ARN, "OPENROUTER_API_KEY_SECRET_ARN") } : {}),
          ...(process.env.AI_CONFIG_ENCRYPTION_KEY_SECRET_ARN ? { AI_CONFIG_ENCRYPTION_KEY: assertSecretArn(process.env.AI_CONFIG_ENCRYPTION_KEY_SECRET_ARN, "AI_CONFIG_ENCRYPTION_KEY_SECRET_ARN") } : {}),
          // Optional: ARN of a secret holding the SMTP password.
          ...(process.env.SMTP_PASS_SECRET_ARN ? { SMTP_PASS: process.env.SMTP_PASS_SECRET_ARN } : {})
        }
      }
    }
  }
};
const common = {
  SourceConfiguration: source,
  InstanceConfiguration: { Cpu: "1024", Memory: "2048", InstanceRoleArn: process.env.INSTANCE_ROLE_ARN },
  // The server mounts every route under the /api prefix, health included.
  HealthCheckConfiguration: { Protocol: "HTTP", Path: "/api/health", Interval: 20, Timeout: 10, HealthyThreshold: 1, UnhealthyThreshold: 5 },
  NetworkConfiguration: { EgressConfiguration: { EgressType: "VPC", VpcConnectorArn: process.env.VPC_CONNECTOR_ARN }, IngressConfiguration: { IsPubliclyAccessible: true } }
};
const created = existing
  ? aws("apprunner", "update-service", { ServiceArn: existing.ServiceArn, ...common })
  : aws("apprunner", "create-service", { ServiceName: serviceName, ...common, Tags: [{ Key: "Environment", Value: environment.toUpperCase() }] });

console.log(JSON.stringify({ service: created.Service.ServiceArn, url: created.Service.ServiceUrl, operation: created.OperationId, db: instance.Endpoint.Address }, null, 2));
