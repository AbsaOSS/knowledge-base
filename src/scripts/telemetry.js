import {
  UwtBroadcastLogApiProvider,
  UwtBroadcastTelemetrySink,
  uwtConnectBroadcastChannel,
  uwtConsoleReporter,
  uwtCreateTelemetry,
} from '@absaoss-cps/ui-watchtower';
import '../telemetry.schema.ts';

const KEY = Symbol.for('knowledge-base.telemetry');

// Development builds only. `?.`: tests import this module under Node, which has no `import.meta.env`.
const report = import.meta.env?.DEV ? uwtConsoleReporter : undefined;

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

/**
 * The same wiring whether telemetry is on or off: `enabled` is the one switch.
 * Forwards to the shell's per-page channel only: never Watchtower's shared default.
 */
function createEngine(config, channelName) {
  const enabled = config?.enabled === true && typeof channelName === 'string' && channelName !== '';
  // The defaults only satisfy the factory while off: the build validates the
  // sidecar, so an enabled configuration always carries the whole identity.
  const { application = 'knowledge-base', environment = '', version = '', eventNamespace } = config ?? {};
  const identity = { application, environment, version, eventNamespace };
  const connection = uwtConnectBroadcastChannel({ channelName, enabled, report });
  const destination = new UwtBroadcastTelemetrySink({ identity, connection, enabled, report });
  const logApi = new UwtBroadcastLogApiProvider({ connection, enabled, report });
  const telemetry = uwtCreateTelemetry({
    identity,
    destination,
    logApi,
    enabled,
    report,
    // Reframed retains the realm across Astro swaps; unload owns its lifetime.
    document: null,
  });
  return {
    telemetry,
    dispose() {
      telemetry.dispose();
      destination.dispose();
      logApi.dispose();
      connection.close();
    },
  };
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
  const engine = createEngine(shell ? readConfig(win, doc) : undefined, shell?.channelName);
  const listeners = [];
  let disposed = false;
  let activated = false;
  let activationPending = true;
  // The navigation being prepared: an earlier page-load must not report its page ready before it is swapped in.
  let preparing;
  const listen = (target, name, handler) => {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  };
  const controller = {
    /** Shared engine; owned by this controller, so callers must not dispose it. */
    telemetry: engine.telemetry,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.forEach((remove) => remove());
      shell?.dispose();
      engine.dispose();
      delete win[KEY];
    },
  };
  win[KEY] = controller;
  if (!shell) return controller;

  const activate = () => {
    if (disposed || !activationPending || preparing) return;
    if (!doc.querySelector('#kb-masthead')) {
      shell.failed();
      return;
    }
    shell.ready();
    activated = true;
    activationPending = false;
  };
  listen(doc, 'astro:before-preparation', (event) => {
    if (disposed) return;
    if (event.from.pathname === event.to.pathname && event.from.search === event.to.search) return;
    activationPending = true;
    preparing = event.signal;
  });
  listen(doc, 'astro:before-swap', (event) => {
    if (event.signal === preparing) preparing = undefined;
  });
  listen(doc, 'astro:page-load', activate);
  // Unlike pagehide, reframed keeps unload on the native iframe window, but
  // Chromium can refuse unload. A host whose web-fragments carries the fix for
  // web-fragments#302 sends web-fragment-unmount before it removes the fragment;
  // without that fix neither event may come, and nothing is disposed.
  listen(win, 'unload', () => controller.dispose());
  listen(win, 'web-fragment-unmount', () => controller.dispose());
  listen(doc, 'DOMContentLoaded', () => {
    if (!activated) activate();
  });
  if (doc.readyState !== 'loading') activate();
  return controller;
}
