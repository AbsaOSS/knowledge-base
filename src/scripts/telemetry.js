import {
  UwtBroadcastLogApiProvider,
  UwtBroadcastTelemetrySink,
  UwtNoopLogApiProvider,
  UwtNoopTelemetrySink,
  uwtConnectBroadcastChannel,
  uwtConsoleReporter,
  uwtCreateTelemetry,
} from '@absaoss-cps/ui-watchtower';
import { BASE_PATH } from '../utils/config.js';
import {
  BI_CATALOG_VIEWED,
  BI_DOCUMENT_OPENED,
  SCENARIO_ROUTE_NAVIGATE,
  STEP_ACTIVATE,
} from '../telemetry.schema.ts';

const KEY = Symbol.for('knowledge-base.telemetry');
const ACTIVATED_BODY = Symbol.for('knowledge-base.telemetry.activated-body');
export const NAVIGATION_TIMEOUT_MS = 30_000;

const ENGINE_OPTIONS = {
  // Reframed retains the realm across Astro swaps; unload owns its lifetime.
  document: null,
  // A deliberate revisit is a new visit, however soon it follows the last.
  bi: { dedupWindowMs: 0 },
  report: uwtConsoleReporter,
};

function readConfig(win, doc) {
  const content = doc.querySelector('meta[name="kb-telemetry"]')?.getAttribute('content');
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    win.console.warn('[KB telemetry] Invalid telemetry configuration; forwarding disabled');
    return undefined;
  }
}

function inertEngine() {
  const telemetry = uwtCreateTelemetry({
    ...ENGINE_OPTIONS,
    identity: { application: 'knowledge-base', environment: '', version: '' },
    destination: new UwtNoopTelemetrySink(),
    logApi: new UwtNoopLogApiProvider(),
    enabled: false,
  });
  return { telemetry, dispose: () => telemetry.dispose() };
}

/** Forwards to the shell's per-page channel only: never Watchtower's shared default. */
function createEngine(win, config, channelName) {
  if (config?.enabled !== true || typeof channelName !== 'string' || !channelName) return inertEngine();
  const { application, environment, version, eventNamespace } = config;
  const identity = { application, environment, version, eventNamespace };
  const report = uwtConsoleReporter;
  const connection = uwtConnectBroadcastChannel({ channelName, report });
  const destination = new UwtBroadcastTelemetrySink({ identity, connection, report });
  const logApi = new UwtBroadcastLogApiProvider({ connection, report });
  const close = () => {
    logApi.dispose();
    destination.dispose();
    connection.close();
  };
  try {
    const telemetry = uwtCreateTelemetry({ ...ENGINE_OPTIONS, identity, destination, logApi });
    return {
      telemetry,
      dispose() {
        telemetry.dispose();
        close();
      },
    };
  } catch {
    close();
    win.console.warn('[KB telemetry] Invalid telemetry configuration; forwarding disabled');
    return inertEngine();
  }
}

/**
 * A faulty deployment adapter must never break the page, so every call into it
 * is contained and the knowledge base falls back to running shell-less.
 */
function connect(win, connectShell) {
  const contain = (call) => {
    try {
      call();
    } catch {
      win.console.warn('[KB telemetry] Shell adapter failed');
    }
  };
  try {
    const shell = connectShell(win);
    if (!shell) return undefined;
    return {
      channelName: shell.channelName,
      ready: () => contain(() => shell.ready()),
      failed: () => contain(() => shell.failed()),
      dispose: () => contain(() => shell.dispose?.()),
    };
  } catch {
    win.console.warn('[KB telemetry] Shell adapter failed; running without a shell');
    return undefined;
  }
}

/**
 * @param {Window} win
 * @param {Document} doc
 * @param {(win: Window) => null | { channelName?: string, ready(): void, failed(): void, dispose?(): void }} connectShell
 *   Deployment-supplied: detects the host shell this page runs in and reports readiness to it.
 */
export function startTelemetry(win, doc, connectShell) {
  if (win[KEY]) return win[KEY];
  const shell = connect(win, connectShell);
  const engine = createEngine(win, shell ? readConfig(win, doc) : undefined, shell?.channelName);
  const listeners = [];
  let active;
  let disposed = false;
  let activated = false;
  let activationPending = true;
  const listen = (target, name, handler) => {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  };
  const settle = (navigation, status, reason) => {
    if (!navigation || navigation.settled) return;
    navigation.settled = true;
    navigation.removeAbort();
    const outcome = reason ? { reason } : undefined;
    if (status === 'abandoned') navigation.scenario.cancel(outcome);
    else navigation.scenario.settle(status, outcome);
  };
  const controller = {
    /** Shared engine; owned by this controller, so callers must not dispose it. */
    telemetry: engine.telemetry,
    dispose() {
      if (disposed) return;
      disposed = true;
      settle(active, 'abandoned', 'fragment-destroyed');
      listeners.forEach((remove) => remove());
      shell?.dispose();
      engine.dispose();
      delete win[KEY];
    },
  };
  win[KEY] = controller;
  if (!shell) return controller;

  const activate = () => {
    if (disposed || !activationPending) return;
    if (active && !active.swapped) return;
    if (!doc.querySelector('#kb-masthead')) {
      shell.failed();
      settle(active, 'failure', 'shell-unavailable');
      return;
    }
    shell.ready();
    activated = true;
    activationPending = false;
    const body = doc.querySelector('wf-body') ?? doc.body ?? doc;
    if (win[ACTIVATED_BODY] === body) return;
    win[ACTIVATED_BODY] = body;
    settle(active, 'success');
    active = undefined;
    const page = JSON.parse(doc.querySelector('meta[name="kb-telemetry-page"]')?.getAttribute('content') || '{}');
    engine.telemetry.bi.track(
      page.kind === 'catalog' ? BI_CATALOG_VIEWED : BI_DOCUMENT_OPENED,
      page.kind === 'catalog' ? { pageKind: page.kind } : { pageKind: page.kind, documentation: page.slug },
    );
  };
  const prepare = (event) => {
    if (disposed) return;
    if (event.from.pathname === event.to.pathname && event.from.search === event.to.search) return;
    settle(active, 'abandoned', 'superseded');
    activationPending = true;
    const scenario = engine.telemetry.scenarios.start({
      name: SCENARIO_ROUTE_NAVIGATE,
      route: event.to.pathname.replace(/\/$/, '') === BASE_PATH ? BASE_PATH : `${BASE_PATH}/:app/*`,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
    });
    scenario.step(STEP_ACTIVATE);
    const navigation = { scenario, signal: event.signal, swapped: false, settled: false };
    active = navigation;
    const aborted = () => settle(navigation, 'abandoned', 'superseded');
    event.signal.addEventListener('abort', aborted, { once: true });
    navigation.removeAbort = () => event.signal.removeEventListener('abort', aborted);
    if (event.signal.aborted) aborted();
    const loader = event.loader;
    event.loader = async () => {
      try {
        await loader();
      } catch (error) {
        settle(navigation, 'failure', 'navigation-error');
        throw error;
      }
      if (event.defaultPrevented && !event.signal.aborted) {
        settle(navigation, 'incomplete', 'browser-fallback');
      }
    };
  };
  listen(doc, 'astro:before-preparation', prepare);
  listen(doc, 'astro:before-swap', (event) => {
    if (active?.signal === event.signal) active.swapped = true;
  });
  listen(doc, 'astro:page-load', activate);
  // Unlike pagehide, reframed keeps unload on the native iframe window.
  listen(win, 'unload', () => controller.dispose());
  listen(doc, 'DOMContentLoaded', () => {
    if (!activated) activate();
  });
  if (doc.readyState !== 'loading') activate();
  return controller;
}
