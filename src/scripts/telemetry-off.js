// Bundled as `kb-telemetry` unless the build sets KB_TELEMETRY=true (see
// astro.config.mjs). It imports nothing, so neither UI Watchtower nor the shell
// adapter reaches the output. Its `telemetry` has the shape of the real engine
// and behaves like it does when inert, so Knowledge Base code calling it works
// unchanged; tests/telemetry-runtime.spec.js holds it to the library's public API.

const noop = () => {};

function inertScenario(options) {
  const id = globalThis.crypto?.randomUUID?.() ?? '';
  const startTime = new Date().toISOString();
  const scenario = {
    get id() { return id; },
    get name() { return options?.name; },
    get status() { return undefined; },
    get isSettled() { return false; },
    get delta() { return 0; },
    step: () => scenario,
    endStep: () => scenario,
    failStep: () => scenario,
    setData: () => scenario,
    aggregateStart: () => scenario,
    aggregateEnd: () => scenario,
    complete: noop,
    incomplete: noop,
    fail: noop,
    cancel: noop,
    settle: noop,
    toRecord: () => ({
      scenarioId: id, scenarioName: options?.name, startTime, delta: 0, elapsed: 0, stepCount: 0, steps: [],
      application: 'knowledge-base',
    }),
  };
  return scenario;
}

const logger = { log: noop, warn: noop, error: noop };

/** The page's telemetry API with telemetry compiled out: records and forwards nothing. */
export const telemetry = {
  scenarios: {
    start: inertScenario,
    find: () => undefined,
    findByName: () => [],
    findByNameAndId: () => undefined,
    getActive: () => [],
    onSettled: () => noop,
    dispose: noop,
  },
  bi: { track: noop, dispose: noop },
  logging: { query: () => Promise.resolve([]), getLogger: () => logger, dispose: noop },
  setUserId: noop,
  flush: noop,
  dispose: noop,
};
