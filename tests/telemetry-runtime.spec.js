import { test, expect } from '@playwright/test';
import { startTelemetry } from '../src/scripts/telemetry.js';
import { telemetry as compiledOut } from '../src/scripts/telemetry-off.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const identity = {
  enabled: true, application: 'knowledge-base', environment: 'TEST',
  eventNamespace: 'com.kb-test', version: '1.0.0+123456789abc',
};

const restores = [];
test.afterEach(() => {
  for (const restore of restores.reverse()) restore();
  restores.length = 0;
});

function harness({ config = identity, channel = 'private-test-channel' } = {}) {
  const state = { records: [], readiness: [], shellDisposals: 0, warnings: [], channels: [] };
  const timers = new Map();
  let nextTimer = 0;
  const win = Object.assign(new EventTarget(), {
    location: { origin: 'https://test.invalid' },
    crypto: globalThis.crypto,
    performance: { now: () => 0 },
    console: { warn: (message) => state.warnings.push(message), log() {} },
    localStorage: { getItem: () => null },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    BroadcastChannel: class {
      closed = false;
      constructor(name) { this.name = name; state.channels.push(this); }
      postMessage(data) {
        if (data.kind === 'event' || data.kind === 'log') state.records.push(data);
      }
      close() { this.closed = true; }
    },
  });
  const connectShell = (target) => {
    expect(target).toBe(win);
    return {
      ...(channel !== null && { channelName: channel }),
      ready: () => state.readiness.push('ready'),
      failed: () => state.readiness.push('failed'),
      dispose: () => state.shellDisposals++,
    };
  };
  for (const name of ['BroadcastChannel', 'crypto', 'performance', 'localStorage', 'setTimeout', 'clearTimeout']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    restores.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
    Object.defineProperty(globalThis, name, { configurable: true, get: () => win[name] });
  }
  const doc = Object.assign(new EventTarget(), {
    readyState: 'complete',
    shell: true,
    querySelector(selector) {
      if (selector === '#kb-masthead') return this.shell ? {} : null;
      if (selector !== 'meta[name="kb-telemetry"]' || config === null) return null;
      return { getAttribute: () => JSON.stringify(config) };
    },
  });
  const prepare = (to = '/knowledge-base/user-guide/', from = '/knowledge-base/') => {
    const controller = new AbortController();
    const event = Object.assign(new Event('astro:before-preparation', { cancelable: true }), {
      from: new URL(from, 'https://test.invalid'),
      to: new URL(to, 'https://test.invalid'),
      signal: controller.signal,
    });
    doc.dispatchEvent(event);
    return event;
  };
  const swap = (event) => {
    doc.dispatchEvent(Object.assign(new Event('astro:before-swap'), { signal: event.signal }));
  };
  const pageLoad = () => doc.dispatchEvent(new Event('astro:page-load'));
  return { win, doc, state, timers, prepare, swap, pageLoad, connectShell };
}

test('initializes once per realm, and again after disposal', () => {
  const h = harness();
  const first = startTelemetry(h.win, h.doc, h.connectShell);
  expect(startTelemetry(h.win, h.doc, h.connectShell)).toBe(first);
  expect(h.state.channels.map((channel) => channel.name)).toEqual(['private-test-channel']);
  first.dispose();
  first.dispose();
  expect(h.state.channels[0].closed).toBe(true);
  expect(h.state.shellDisposals).toBe(1);
  const remount = startTelemetry(h.win, h.doc, h.connectShell);
  expect(remount).not.toBe(first);
  expect(h.state.channels).toHaveLength(2);
  remount.dispose();
});

test('exposes the shared Watchtower API, forwarded with the deployment identity', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  expect(startTelemetry(h.win, h.doc, h.connectShell).telemetry).toBe(instance.telemetry);
  instance.telemetry.bi.track('kb-test-event', { count: 1 });
  const scenario = instance.telemetry.scenarios.start({ name: 'kb-test-scenario' });
  scenario.step('work');
  scenario.complete();
  instance.telemetry.logging.getLogger('kb-test').warn('test message');
  expect(h.state.records.find((record) => record.eventType === 'com.kb-test.bi')).toMatchObject({
    payload: { application: 'knowledge-base', eventName: 'kb-test-event' },
    metadata: { application: 'knowledge-base', environment: 'TEST', appVersion: identity.version },
  });
  expect(h.state.records.some((record) => record.eventType === 'com.kb-test.scenario' &&
    record.payload.scenarioName === 'kb-test-scenario' && record.payload.status === 'success')).toBe(true);
  expect(h.state.records.some((record) => record.kind === 'log' && record.record.logger === 'kb-test')).toBe(true);
  instance.dispose();
});

test('disposal settles custom scenarios and closes their shared channel', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  const scenario = instance.telemetry.scenarios.start({ name: 'kb-custom-operation' });
  instance.dispose();
  expect(scenario.status).toBe('abandoned');
  expect(h.state.records.filter((record) => record.eventType?.endsWith('.scenario'))
    .map((record) => record.payload.status)).toEqual(['abandoned']);
  expect(h.state.channels[0].closed).toBe(true);
  expect(h.timers.size).toBe(0);
});

test('reports readiness once per page activation and emits nothing of its own', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  h.pageLoad();
  expect(h.state.readiness).toEqual(['ready']);
  const event = h.prepare();
  h.swap(event);
  h.pageLoad();
  h.doc.dispatchEvent(new Event('DOMContentLoaded'));
  expect(h.state.readiness).toEqual(['ready', 'ready']);
  // The same page again (a hash link): not a new activation.
  h.prepare('/knowledge-base/user-guide/', '/knowledge-base/user-guide/');
  h.pageLoad();
  expect(h.state.readiness).toEqual(['ready', 'ready']);
  expect(h.state.records).toEqual([]);
  instance.dispose();
});

test('an old page-load cannot report a navigation that has not swapped yet', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  const first = h.prepare();
  const second = h.prepare('/knowledge-base/', '/knowledge-base/user-guide/');
  h.swap(first);
  h.pageLoad();
  expect(h.state.readiness).toEqual(['ready']);
  h.swap(second);
  h.pageLoad();
  expect(h.state.readiness).toEqual(['ready', 'ready']);
  instance.dispose();
});

for (const config of [null, { ...identity, enabled: false }, { enabled: 'malformed' }]) {
  test(`shell readiness works without active event forwarding: ${JSON.stringify(config)}`, () => {
    const h = harness({ config });
    const instance = startTelemetry(h.win, h.doc, h.connectShell);
    h.pageLoad();
    expect(h.state.readiness).toEqual(['ready']);
    instance.dispose();
    expect(h.state.shellDisposals).toBe(1);
  });
}

test('a page without the knowledge base shell reports failure to the host shell', () => {
  const h = harness();
  h.doc.shell = false;
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  expect(h.state.readiness).toEqual(['failed']);
  instance.dispose();
});

test('a throwing shell adapter degrades to running without a shell', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, () => { throw new Error('adapter-bug'); });
  h.pageLoad();
  expect(h.state.warnings).toHaveLength(1);
  expect(() => instance.dispose()).not.toThrow();
});

test('a throwing shell callback does not interrupt telemetry or disposal', () => {
  const h = harness();
  const failing = () => { throw new Error('adapter-bug'); };
  const instance = startTelemetry(h.win, h.doc, (win) => ({
    ...h.connectShell(win), ready: failing, dispose: failing,
  }));
  instance.telemetry.bi.track('kb-test-event');
  expect(h.state.records.map((record) => record.payload.eventName)).toEqual(['kb-test-event']);
  expect(() => instance.dispose()).not.toThrow();
  expect(h.state.channels[0].closed).toBe(true);
  expect(h.state.warnings).toHaveLength(2);
});

/** Public members of a class or interface in the library's published typings. */
function publicMembers(name) {
  const types = createRequire(import.meta.url).resolve('@absaoss-cps/ui-watchtower')
    .replace(/fesm2022\/.*$/, 'types/absaoss-cps-ui-watchtower.d.ts');
  const source = readFileSync(types, 'utf8');
  const start = source.search(new RegExp(`^(?:declare class|interface) ${name} \\{`, 'm'));
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {4}(?:readonly |get )?(\w+)[(:]/gm)]
    .map(([, member]) => member)
    .filter((member) => member !== 'constructor');
}

test('the compiled-out stub implements the whole public telemetry API', () => {
  const scenario = compiledOut.scenarios.start({ name: 'kb-test-scenario' });
  for (const [name, target] of [
    ['UwtTelemetry', compiledOut],
    ['UwtScenarioTelemetry', compiledOut.scenarios],
    ['UwtBITelemetry', compiledOut.bi],
    ['UwtLogTelemetry', compiledOut.logging],
    ['UwtScenario', scenario],
    ['UwtLogger', compiledOut.logging.getLogger('kb-test')],
  ]) {
    const members = publicMembers(name);
    expect(members.length, name).toBeGreaterThan(0);
    for (const member of members) expect(member in target, `${name}.${member}`).toBe(true);
  }
});

test('the compiled-out stub behaves like an inert engine and imports nothing', async () => {
  const scenario = compiledOut.scenarios.start({ name: 'kb-test-scenario' });
  expect(scenario.step('work').setData({ count: 1 })).toBe(scenario);
  scenario.complete();
  expect(scenario.name).toBe('kb-test-scenario');
  expect(scenario.isSettled).toBe(false);
  expect(compiledOut.scenarios.getActive()).toEqual([]);
  expect(compiledOut.scenarios.find(scenario.id)).toBeUndefined();
  expect(await compiledOut.logging.query()).toEqual([]);
  expect(() => compiledOut.bi.track('kb-test-event')).not.toThrow();
  expect(readFileSync(new URL('../src/scripts/telemetry-off.js', import.meta.url), 'utf8'))
    .not.toMatch(/^\s*import\b|\bimport\(/m);
});
