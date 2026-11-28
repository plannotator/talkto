import { parentPort, workerData } from "node:worker_threads";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/*
  One share of mcp-compat.test.mjs's checks, in its own thread: compile each distinct schema it was
  given once, with the engine named, and check every reply of that tool against it. Validators are
  configured as the MCP SDK's AjvJsonSchemaValidator, except `code.optimize`, which only tidies
  the generated code (every reply validates the same) and compiles ~120 KB tool schemas 3x faster.
*/

const make = (Engine) => {
  const ajv = new Engine({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    code: { optimize: false },
  });
  addFormats(ajv);
  return ajv;
};
const engines = { "draft-07": make(Ajv), "2020-12": make(Ajv2020) };

const { groups, replies } = workerData;
const failures = [];
for (const group of groups) {
  const ajv = engines[group.engine];
  const validate = ajv.compile(group.schema);
  for (const { tool, step, reply } of replies)
    if (tool === group.tool && !validate(reply))
      for (const source of group.sources)
        failures.push(
          `${source} (${group.engine}), ${tool}, ${step}: Structured content does not match the tool's output schema: ${ajv.errorsText(validate.errors)}`,
        );
}
parentPort.postMessage(failures);
