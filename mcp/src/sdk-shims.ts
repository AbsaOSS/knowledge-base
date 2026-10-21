// Bundle-time stand-in for `@modelcontextprotocol/server/_shims` (aliased in
// scripts/build-mcp.js). The SDK's Node shim makes Ajv the default JSON Schema validator,
// 143 KB minified; the server uses that validator only for elicitation results and
// fromJsonSchema(), neither of which this server touches. The SDK's own Cloudflare Workers
// validator does the same job in a fraction of the size. Running from source (dev, tests)
// keeps the SDK's shim.
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
export { default as process } from 'node:process';
