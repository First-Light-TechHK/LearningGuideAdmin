// Provision the independent Admin DEV stack: logical RDS database, Secrets, App Runner.
// Required env: VPC_ID, SUBNET_IDS (comma separated), SECURITY_GROUP_ID, ECR_IMAGE
// Optional: DB_INSTANCE_CLASS (default db.t4g.micro), REGION (default ap-southeast-1)
// Operator-only. Never prints secret values. Run without --apply for a dry run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const region = process.env.REGION || "ap-southeast-1";
const apply = process.argv.includes("--apply");
const required = ["VPC_ID", "SUBNET_IDS", "SECURITY_GROUP_ID", "GITHUB_CONNECTION_ARN", "INSTANCE_ROLE_ARN", "VPC_CONNECTOR_ARN"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const repositoryUrl = process.env.REPOSITORY_URL || "https://github.com/First-Light-TechHK/LearningGuideAdmin";
const branch = process.env.ADMIN_BRANCH || "dev";

function aws(service, operation, input = {}) {
  const args = [service, operation, "--region", region, "--output", "json"];
  if (Object.keys(input).length) args.push("--cli-input-json", JSON.stringify(input));
  return JSON.parse(execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "{}");
}
function optional(service, operation, input) {
  try { return aws(service, operation, input); }
  catch (error) { if (/ResourceNotFound|NoSuchEntity|DBInstanceNotFound|DBSubnetGroupNotFound/i.test(String(error.stderr))) return null; throw error; }
}

const plan = { region, apply, steps: [] };
const dbId = "learning-guide-admin-dev";
const serviceName = "learning-guide-admin-dev";
const dbPassword = randomBytes(24).toString("hex");

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
    DBSubnetGroupDescription: "Learning Guide admin DEV",
    SubnetIds: process.env.SUBNET_IDS.split(",").map((value) => value.trim()),
    Tags: [{ Key: "Environment", Value: "DEV" }, { Key: "Project", Value: "LearningGuide" }]
  });
}

// 2) RDS instance (PostgreSQL, private)
if (!optional("rds", "describe-db-instances", { DBInstanceIdentifier: dbId })) {
  aws("rds", "create-db-instance", {
    DBInstanceIdentifier: dbId,
    DBInstanceClass: process.env.DB_INSTANCE_CLASS || "db.t4g.micro",
    Engine: "postgres",
    // Keep the DEV engine on the same minor line as learning-guide-sit.
    EngineVersion: process.env.DB_ENGINE_VERSION || "16.13",
    AllocatedStorage: 20,
    DBName: "learning_guide_admin_dev",
    MasterUsername: "lg_admin_dev",
    MasterUserPassword: dbPassword,
    VpcSecurityGroupIds: [process.env.SECURITY_GROUP_ID],
    DBSubnetGroupName: dbId,
    PubliclyAccessible: false,
    BackupRetentionPeriod: 1,
    StorageEncrypted: true,
    Tags: [{ Key: "Environment", Value: "DEV" }, { Key: "Project", Value: "LearningGuide" }]
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
const databaseUrl = `postgresql://lg_admin_dev:${dbPassword}@${instance.Endpoint.Address}:${instance.Endpoint.Port}/learning_guide_admin_dev`;
const secrets = { DATABASE_URL: databaseUrl, ADMIN_API_KEY: randomBytes(32).toString("hex") };
const secretArns = {};
for (const [key, value] of Object.entries(secrets)) {
  const Name = `learning-guide/admin/dev/${key.toLowerCase()}`;
  const existing = optional("secretsmanager", "describe-secret", { SecretId: Name });
  secretArns[key] = existing
    ? existing.ARN
    : aws("secretsmanager", "create-secret", { Name, SecretString: value, Tags: [{ Key: "Environment", Value: "DEV" }] }).ARN;
}

// 4) App Runner service
const service = optional("apprunner", "describe-service", { ServiceArn: `arn:aws:apprunner:${region}:${process.env.AWS_ACCOUNT_ID}:service/${serviceName}/placeholder` });
const existing = aws("apprunner", "list-services", {}).ServiceSummaryList.find((item) => item.ServiceName === serviceName);
const source = {
  // Source-based deployment: App Runner builds and deploys on every push, like
  // the Portal services. No local image build.
  AutoDeploymentsEnabled: true,
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
        RuntimeEnvironmentVariables: { NODE_ENV: "production", APP_ENV: "DEV", PORT: "3000" },
        RuntimeEnvironmentSecrets: { DATABASE_URL: secretArns.DATABASE_URL, ADMIN_API_KEY: secretArns.ADMIN_API_KEY }
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
  : aws("apprunner", "create-service", { ServiceName: serviceName, ...common, Tags: [{ Key: "Environment", Value: "DEV" }] });

console.log(JSON.stringify({ service: created.Service.ServiceArn, url: created.Service.ServiceUrl, operation: created.OperationId, db: instance.Endpoint.Address }, null, 2));
