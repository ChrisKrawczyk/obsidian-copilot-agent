import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "docs", "schemas", "preset-pack-v1.json");

function fail(message) {
  console.error(`[schema:check] ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function requiredIncludes(obj, keys, label) {
  assert(Array.isArray(obj?.required), `${label}.required must be an array`);
  for (const key of keys) {
    assert(obj.required.includes(key), `${label}.required missing ${key}`);
  }
}

function branchConstNames(oneOf, property) {
  assert(Array.isArray(oneOf), `${property} oneOf must be an array`);
  return oneOf
    .map((branch) => {
      const ref = branch.$ref;
      const resolved = typeof ref === "string"
        ? schema.definitions[ref.replace("#/definitions/", "")]
        : branch;
      return resolved?.properties?.[property]?.const;
    })
    .filter(Boolean)
    .sort();
}

function commentText(value) {
  if (!value || typeof value !== "object") return "";
  const pieces = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "$comment" || key === "description") pieces.push(String(child));
    else if (typeof child === "object") pieces.push(commentText(child));
  }
  return pieces.join("\n");
}

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

assert(schema.$schema === "http://json-schema.org/draft-07/schema#", "unexpected $schema");
assert(schema.$id === "https://github.com/ChrisKrawczyk/obsidian-copilot-agent/schemas/preset-pack-v1.json", "unexpected $id");
requiredIncludes(schema, ["schemaVersion", "id", "label", "version", "presets"], "top");
assert(schema.additionalProperties === true, "top-level additionalProperties must be true");
assert(schema.properties?.schemaVersion?.const === 1, "schemaVersion must use const: 1");
assert(schema.properties?.id?.not?.const === "builtin", "pack id must reserve builtin via not.const");
assert(schema.properties?.presets?.minItems === 1, "presets must require at least one item");

const preset = schema.definitions?.preset;
requiredIncludes(preset, ["id", "label", "server", "credentials"], "preset");
assert(preset.additionalProperties === false, "preset additionalProperties must be false");
assert(preset.properties?.id?.pattern === "^[A-Za-z0-9][A-Za-z0-9._-]*$", "preset id pattern drifted");

const serverKinds = branchConstNames(schema.definitions?.server?.oneOf, "transport");
assert(serverKinds.join(",") === "http,stdio", `server transport branches drifted: ${serverKinds.join(",")}`);
requiredIncludes(schema.definitions.httpServer, ["name", "transport", "url"], "httpServer");
requiredIncludes(schema.definitions.stdioServer, ["name", "transport", "command"], "stdioServer");

const credentialKinds = branchConstNames(schema.definitions?.credentials?.oneOf, "kind");
assert(
  credentialKinds.join(",") === "command-based,none,oauth-pkce,static-bearer",
  `credential branches drifted: ${credentialKinds.join(",")}`,
);
requiredIncludes(schema.definitions.credentialsStaticBearer, ["kind", "token"], "credentialsStaticBearer");
requiredIncludes(schema.definitions.credentialsCommandBased, ["kind", "command"], "credentialsCommandBased");
requiredIncludes(
  schema.definitions.credentialsOauthPkce,
  ["kind", "authorizationEndpoint", "tokenEndpoint", "clientId", "scopes"],
  "credentialsOauthPkce",
);
requiredIncludes(schema.definitions.preflight, ["type", "command"], "preflight");

const comments = commentText(schema);
for (const phrase of [
  "strict JSON",
  "JSONC",
  "1 MB",
  "100 KB",
  "Duplicate preset ids",
  "URL",
  "private-network",
  "__NEEDS_VALUE__",
]) {
  assert(comments.includes(phrase), `schema must document validator/parser-only rule: ${phrase}`);
}

console.log("[schema:check] preset-pack-v1 schema invariants OK");
