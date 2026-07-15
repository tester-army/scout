import { parseHeaderKvFlags, parseKeyValueFlags } from "./call-command.js";
import { ScoutError } from "./errors.js";
import { appendFinding } from "./findings.js";
import {
  fuzzBodySize,
  generateBaselineValue,
  MAX_FUZZ_BODY_BYTES,
  planFuzzCases,
  runFuzz,
  selectFuzzCases,
  selectJsonRequestSchema,
} from "./fuzz-engine.js";
import { createExecutorContext, matchOperation } from "./http-executor.js";
import { scopeOperations } from "./operation-filter.js";
import { stringifyJson } from "./output.js";
import { interpolateVars, loadVars } from "./session-vars.js";
import { operationKey, parseHttpMethodArg } from "./spec-loader.js";
import { isInteractive, readJsonStdin } from "./utils.js";
import { validateSchemaValue } from "./verdict.js";

export type FuzzOptions = {
  json?: boolean;
  pathParam?: string[];
  query?: string[];
  header?: string[];
  data?: string;
  dataStdin?: boolean;
  maxCases?: number;
  case?: string;
  oversizedLength?: number;
  dryRun?: boolean;
  authProfile?: string;
};

/** Parses an optional user-supplied JSON baseline body. */
async function parseBaseline(options: FuzzOptions): Promise<unknown | undefined> {
  if (options.dataStdin) return readJsonStdin("fuzz baseline");
  if (options.data === undefined) return undefined;
  try {
    return JSON.parse(options.data) as unknown;
  } catch {
    throw new ScoutError("Invalid JSON in --data.", {
      code: "INVALID_JSON",
      hint: "Pass a valid baseline body, or omit --data to generate one from the schema.",
    });
  }
}

/** Plans or executes schema-driven request-body fuzz cases for one operation. */
export async function runFuzzCommand(
  method: string,
  path: string,
  options: FuzzOptions,
): Promise<void> {
  const vars = loadVars();
  const interp = (text: string): string => interpolateVars(text, vars);
  path = interp(path);
  if (options.data !== undefined) options.data = interp(options.data);
  const httpMethod = parseHttpMethodArg(method);
  if (httpMethod === "get" || httpMethod === "head") {
    throw new ScoutError(`${httpMethod.toUpperCase()} request bodies cannot be fuzzed.`, {
      code: "VALIDATION_ERROR",
      hint: "Choose an operation with a JSON request body, usually POST, PUT, PATCH, or DELETE.",
    });
  }

  const context = createExecutorContext({
    authProfile: options.authProfile,
  });
  const match = matchOperation(
    scopeOperations(context.operations, context.policy),
    httpMethod,
    path,
  );
  if (!match) {
    throw new ScoutError(`Operation ${httpMethod.toUpperCase()} ${path} not found in spec.`, {
      code: "NOT_FOUND",
      hint: "Run `scout endpoints --json` to list exact method/path pairs.",
    });
  }

  const operation = match.operation;
  const schema = selectJsonRequestSchema(operation);
  if (schema === null) {
    throw new ScoutError(`${operationKey(operation)} has no JSON request-body schema.`, {
      code: "VALIDATION_ERROR",
      hint: `Run \`scout schema ${operation.method.toUpperCase()} ${operation.path} --json\` and choose an operation with application/json content.`,
    });
  }

  const hasSuppliedBaseline = options.data !== undefined || options.dataStdin === true;
  const suppliedBaseline = await parseBaseline(options);
  const baseline = hasSuppliedBaseline ? suppliedBaseline : generateBaselineValue(schema);
  if (fuzzBodySize(baseline) > MAX_FUZZ_BODY_BYTES) {
    throw new ScoutError(`Fuzz baseline exceeds ${MAX_FUZZ_BODY_BYTES} bytes.`, {
      code: "VALIDATION_ERROR",
      hint: "Use a smaller synthetic baseline. Scout does not fuzz large request bodies automatically.",
    });
  }
  const baselineValidation = validateSchemaValue(schema, context.loadedSpec.specVersion, baseline);
  if (!baselineValidation) {
    throw new ScoutError("Request schema could not be compiled for fuzzing.", {
      code: "VALIDATION_ERROR",
      hint: "Resolve invalid schemas or unresolved $refs before executing fuzz cases.",
    });
  }
  if (baselineValidation?.valid === false) {
    const source = hasSuppliedBaseline ? "Supplied" : "Generated";
    throw new ScoutError(`${source} fuzz baseline does not match the request schema.`, {
      code: "VALIDATION_ERROR",
      hint: `${baselineValidation.errors.slice(0, 5).join("; ")}. Provide a known-valid synthetic body with --data or --data-stdin.`,
    });
  }
  const planOptions = {
    specVersion: context.loadedSpec.specVersion,
    ...(options.maxCases !== undefined ? { maxCases: options.maxCases } : {}),
    ...(options.oversizedLength !== undefined ? { oversizedLength: options.oversizedLength } : {}),
  };
  const pathParams = {
    ...match.extractedPathParams,
    ...parseKeyValueFlags((options.pathParam ?? []).map(interp), "--path-param"),
  };

  if (options.dryRun) {
    const cases = selectFuzzCases(planFuzzCases(schema, baseline, planOptions), options.case);
    printResult(
      {
        operation: operationKey(operation),
        baseline: hasSuppliedBaseline ? "supplied" : "generated",
        ...(!hasSuppliedBaseline ? { generatedBaseline: baseline } : {}),
        casesPlanned: cases.length,
        cases: cases.map(({ body: _body, rawBody: _rawBody, ...fuzzCase }) => fuzzCase),
        dryRun: true,
      },
      options,
    );
    return;
  }

  const summary = await runFuzz(context, operation, schema, baseline, {
    ...planOptions,
    ...(options.case ? { caseId: options.case } : {}),
    pathParams,
    query: parseKeyValueFlags((options.query ?? []).map(interp), "--query"),
    headers: parseHeaderKvFlags((options.header ?? []).map(interp)),
  });
  for (const finding of summary.findings) appendFinding(finding, context.cwd, summary.runId);

  printResult(
    {
      operation: operationKey(operation),
      baseline: hasSuppliedBaseline ? "supplied" : "generated",
      ...summary,
    },
    options,
  );
}

/** Prints fuzz output as JSON or a compact human summary. */
function printResult(result: Record<string, unknown>, options: FuzzOptions): void {
  if (options.json || !isInteractive()) {
    console.log(stringifyJson(result));
    return;
  }

  if (result.dryRun) {
    console.log(`Planned ${result.casesPlanned as number} fuzz cases for ${result.operation}.`);
    return;
  }
  console.log(
    `Fuzz complete: ${result.casesRun as number}/${result.casesPlanned as number} cases run, ${result.findingsCreated as number} findings recorded.`,
  );
}
