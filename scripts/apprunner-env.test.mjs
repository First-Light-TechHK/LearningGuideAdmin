import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpsUrl, assertSecretArn, mergeRuntimeConfiguration } from "./apprunner-env.mjs";

function codeRepository() {
  return {
    CodeRepository: {
      CodeConfiguration: {
        CodeConfigurationValues: {
          Runtime: "NODEJS_22",
          Port: "3000",
          RuntimeEnvironmentVariables: { NODE_ENV: "production", APP_ENV: "DEV", PORT: "3000" },
          RuntimeEnvironmentSecrets: {
            DATABASE_URL: "arn:aws:secretsmanager:ap-southeast-1:851987565851:secret:learning-guide/admin/dev/database_url",
            ADMIN_API_KEY: "arn:aws:secretsmanager:ap-southeast-1:851987565851:secret:learning-guide/admin/dev/admin_api_key",
          },
        },
      },
    },
  };
}

const openRouterArn = "arn:aws:secretsmanager:ap-southeast-1:851987565851:secret:learning-guide/admin/dev/openrouter_api_key";
const encryptionArn = "arn:aws:secretsmanager:ap-southeast-1:851987565851:secret:learning-guide/admin/dev/ai_config_encryption_key";

test("mergeRuntimeConfiguration preserves DATABASE_URL and ADMIN_API_KEY while adding tutor secrets", () => {
  const result = mergeRuntimeConfiguration(codeRepository(), {
    secrets: { OPENROUTER_API_KEY: openRouterArn, AI_CONFIG_ENCRYPTION_KEY: encryptionArn },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied.secrets, ["OPENROUTER_API_KEY", "AI_CONFIG_ENCRYPTION_KEY"]);
  const values = result.sourceConfiguration.CodeRepository.CodeConfiguration.CodeConfigurationValues;
  assert.equal(values.RuntimeEnvironmentSecrets.DATABASE_URL, "arn:aws:secretsmanager:ap-southeast-1:851987565851:secret:learning-guide/admin/dev/database_url");
  assert.equal(values.RuntimeEnvironmentSecrets.OPENROUTER_API_KEY, openRouterArn);
  assert.equal(values.RuntimeEnvironmentSecrets.AI_CONFIG_ENCRYPTION_KEY, encryptionArn);
});

test("mergeRuntimeConfiguration reports no change when secrets already match", () => {
  const source = codeRepository();
  source.CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentSecrets.OPENROUTER_API_KEY = openRouterArn;
  source.CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentSecrets.AI_CONFIG_ENCRYPTION_KEY = encryptionArn;
  const result = mergeRuntimeConfiguration(source, {
    secrets: { OPENROUTER_API_KEY: openRouterArn, AI_CONFIG_ENCRYPTION_KEY: encryptionArn },
  });
  assert.equal(result.changed, false);
});

test("mergeRuntimeConfiguration skips empty optional variables", () => {
  const result = mergeRuntimeConfiguration(codeRepository(), {
    variables: { AI_AVAILABLE_MODELS: "" },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.applied, { variables: [], secrets: [] });
});

test("mergeRuntimeConfiguration supports image-based services", () => {
  const source = {
    ImageRepository: {
      ImageConfiguration: {
        Port: "3000",
        RuntimeEnvironmentVariables: {},
      },
    },
  };
  const result = mergeRuntimeConfiguration(source, { variables: { AI_AVAILABLE_MODELS: "openai/gpt-4o-mini" } });
  assert.equal(result.sourceConfiguration.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables.AI_AVAILABLE_MODELS, "openai/gpt-4o-mini");
});

test("mergeRuntimeConfiguration rejects an unknown source configuration", () => {
  assert.throws(() => mergeRuntimeConfiguration({}, {}), /neither CodeRepository nor ImageRepository/);
});

test("assertPublicHttpsUrl accepts an App Runner https origin", () => {
  assert.equal(
    assertPublicHttpsUrl("https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com"),
    "https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com",
  );
});

test("assertPublicHttpsUrl rejects local-development values", () => {
  assert.throws(() => assertPublicHttpsUrl("http://localhost:3000"), /must use https/);
  assert.throws(() => assertPublicHttpsUrl("https://admin.example.com:3000"), /must not include a port/);
  assert.throws(() => assertPublicHttpsUrl("https://localhost"), /must not point to localhost/);
  assert.throws(() => assertPublicHttpsUrl("https://[::1]"), /must not point to localhost/);
  assert.throws(() => assertPublicHttpsUrl("https://user:pass@ks.example.com"), /must not contain credentials/);
});

test("assertSecretArn requires a Secrets Manager ARN", () => {
  assert.equal(assertSecretArn(openRouterArn, "OPENROUTER_API_KEY_SECRET_ARN"), openRouterArn);
  assert.throws(() => assertSecretArn("sk-or-plain-text", "OPENROUTER_API_KEY_SECRET_ARN"), /not a Secrets Manager ARN/);
  assert.throws(() => assertSecretArn("", "OPENROUTER_API_KEY_SECRET_ARN"), /required/);
});
