import { test, expect } from '@playwright/test';
import { startTelemetry, NAVIGATION_TIMEOUT_MS } from '../src/scripts/telemetry.js';
import { connectShell as noShell } from '../src/scripts/no-shell.js';
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

function harness({ config = identity, framed = true, channel = 'private-test-channel' } = {}) {
  const state = { records: [], readiness: [], shellDisposals: 0, warnings: [], channels: [], now: 0 };
  const timers = new Map();
  let nextTimer = 0;
  const win = Object.assign(new EventTarget(), {
    location: { origin: 'https://test.invalid' },
    crypto: globalThis.crypto,
    performance: { now: () => state.now },
    console: { warn: (message) => state.warnings.push(message), log() {} },
    localStorage: { getItem: () => null },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: state.now + delay });
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
    if (!framed) return null;
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
    descriptor: { kind: 'catalog' },
    shell: true,
    querySelector(selector) {
      if (selector === '#kb-masthead') return this.shell ? {} : null;
      if (selector === 'wf-body') return this.body ?? null;
      const data = selector === 'meta[name="kb-telemetry"]' ? config : this.descriptor;
      return data === null ? null : { getAttribute: () => JSON.stringify(data) };
    },
  });
  const tick = (ms) => {
    const end = state.now + ms;
    for (;;) {
      const first = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!first || first[1].due > end) break;
      state.now = first[1].due;
      timers.delete(first[0]);
      first[1].callback();
    }
    state.now = end;
  };
  const prepare = (loader = async () => {}, to = '/knowledge-base/user-guide/', from = '/knowledge-base/') => {
    const controller = new AbortController();
    const event = Object.assign(new Event('astro:before-preparation', { cancelable: true }), {
      from: new URL(from, 'https://test.invalid'),
      to: new URL(to, 'https://test.invalid'),
      signal: controller.signal, loader,
    });
    doc.dispatchEvent(event);
    return { event, controller };
  };
  const swap = (event) => {
    doc.body = {};
    doc.dispatchEvent(Object.assign(new Event('astro:before-swap'), { signal: event.signal }));
  };
  return { win, doc, state, timers, tick, prepare, swap, connectShell };
}

test('initializes once and forwards the KB visit with its deployment identity', () => {
  const h = harness();
  const first = startTelemetry(h.win, h.doc, h.connectShell);
  expect(startTelemetry(h.win, h.doc, h.connectShell)).toBe(first);
  h.doc.dispatchEvent(new Event('astro:page-load'));
  expect(h.state.channels).toHaveLength(1);
  expect(h.state.records).toHaveLength(1);
  expect(h.state.records[0]).toMatchObject({
    eventType: 'com.kb-test.bi',
    payload: { application: 'knowledge-base', eventName: 'kb-catalog-viewed', metadata: { pageKind: 'catalog' } },
    metadata: { application: 'knowledge-base', environment: 'TEST', appVersion: identity.version },
  });
  first.dispose();
  expect(h.timers.size).toBe(0);
  expect(h.state.channels[0].closed).toBe(true);
});

test('exposes the shared Watchtower API to Knowledge Base scripts', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  expect(instance.telemetry).toBeDefined();
  expect(startTelemetry(h.win, h.doc, h.connectShell).telemetry).toBe(instance.telemetry);
  instance.telemetry.bi.track('kb-test-event', { count: 1 });
  const scenario = instance.telemetry.scenarios.start({ name: 'kb-test-scenario' });
  scenario.step('work');
  scenario.complete();
  instance.telemetry.logging.getLogger('kb-test').warn('test message');
  expect(h.state.records.some((record) => record.eventType?.endsWith('.bi') &&
    record.payload.eventName === 'kb-test-event')).toBe(true);
  expect(h.state.records.some((record) => record.eventType?.endsWith('.scenario') &&
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

test('records deliberate revisits even inside the BI deduplication window', async () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  for (let i = 0; i < 2; i++) {
    const { event } = h.prepare(
      async () => {},
      i === 0 ? '/knowledge-base/user-guide/' : '/knowledge-base/',
      i === 0 ? '/knowledge-base/' : '/knowledge-base/user-guide/',
    );
    await event.loader();
    h.doc.descriptor = i === 0 ? { kind: 'packaged', slug: 'user-guide' } : { kind: 'catalog' };
    h.swap(event);
    h.doc.dispatchEvent(new Event('astro:page-load'));
  }
  expect(h.state.records.filter((record) => record.eventType?.endsWith('.bi'))
    .map((record) => record.payload.eventName))
    .toEqual(['kb-catalog-viewed', 'kb-document-opened', 'kb-catalog-viewed']);
  instance.dispose();
});

test('successful internal navigation emits one scenario and one document visit', async () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  const { event } = h.prepare();
  await event.loader();
  h.doc.descriptor = { kind: 'packaged', slug: 'user-guide', title: 'never-recorded' };
  h.swap(event);
  h.doc.dispatchEvent(new Event('astro:page-load'));
  h.doc.dispatchEvent(new Event('astro:page-load'));
  const scenario = h.state.records.find((record) => record.eventType.endsWith('.scenario'));
  expect(scenario.payload).toMatchObject({
    application: 'knowledge-base', scenarioName: 'kb-route-navigate',
    route: '/knowledge-base/:app/*', status: 'success', stepCount: 1,
  });
  expect(h.state.records.at(-1).payload.metadata)
    .toEqual({ pageKind: 'packaged', documentation: 'user-guide' });
  expect(h.state.records).toHaveLength(3);
  instance.dispose();
});

for (const outcome of ['failure', 'abandoned', 'timeout', 'incomplete']) {
  test(`settles navigation ${outcome} exactly once`, async () => {
    const h = harness();
    const instance = startTelemetry(h.win, h.doc, h.connectShell);
    const { event, controller } = h.prepare(outcome === 'failure'
      ? async () => { throw new Error('private-error'); }
      : async () => {});
    if (outcome === 'failure') await expect(event.loader()).rejects.toThrow('private-error');
    if (outcome === 'abandoned') controller.abort();
    if (outcome === 'timeout') {
      h.tick(NAVIGATION_TIMEOUT_MS - 1);
      expect(h.state.records.filter((record) => record.eventType.endsWith('.scenario'))).toHaveLength(0);
      h.tick(1);
    }
    if (outcome === 'incomplete') { event.preventDefault(); await event.loader(); }
    h.doc.dispatchEvent(new Event('astro:page-load'));
    instance.dispose();
    const records = h.state.records.filter((record) => record.eventType.endsWith('.scenario'));
    expect(records).toHaveLength(1);
    expect(records[0].payload.status).toBe(outcome);
    expect(records[0].payload.reason).toBe({
      failure: 'navigation-error',
      abandoned: 'superseded',
      timeout: undefined,
      incomplete: 'browser-fallback',
    }[outcome]);
    expect(JSON.stringify(records)).not.toContain('private-error');
    expect(h.timers.size).toBe(0);
  });
}

test('superseding and disposing navigation cannot emit two terminal outcomes', async () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  const first = h.prepare();
  h.prepare();
  await first.event.loader();
  first.controller.abort();
  instance.dispose();
  instance.dispose();
  expect(h.state.records.filter((record) => record.eventType.endsWith('.scenario'))
    .map((record) => record.payload.status)).toEqual(['abandoned', 'abandoned']);
  expect(h.timers.size).toBe(0);
  const remount = startTelemetry(h.win, h.doc, h.connectShell);
  expect(remount).not.toBe(instance);
  expect(h.state.channels).toHaveLength(2);
  remount.dispose();
});

test('HMR replacement does not count the same page activation again', () => {
  const h = harness();
  startTelemetry(h.win, h.doc, h.connectShell).dispose();
  const replacement = startTelemetry(h.win, h.doc, h.connectShell);
  expect(h.state.records).toHaveLength(1);
  replacement.dispose();
});

test('an old page-load cannot complete a newer navigation that has not swapped', async () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  const first = h.prepare();
  const second = h.prepare();
  h.swap(first.event);
  h.doc.dispatchEvent(new Event('astro:page-load'));
  expect(h.state.records.filter((record) => record.eventType.endsWith('.scenario'))).toHaveLength(1);
  h.swap(second.event);
  h.doc.dispatchEvent(new Event('astro:page-load'));
  expect(h.state.records.filter((record) => record.eventType.endsWith('.scenario'))
    .map((record) => record.payload.status)).toEqual(['abandoned', 'success']);
  instance.dispose();
});

for (const config of [null, { ...identity, enabled: false }, { enabled: 'malformed' }]) {
  test(`shell readiness works without active event forwarding: ${JSON.stringify(config)}`, () => {
    const h = harness({ config });
    const instance = startTelemetry(h.win, h.doc, h.connectShell);
    h.doc.dispatchEvent(new Event('astro:page-load'));
    expect(h.state.readiness).toEqual(['ready']);
    expect(h.state.records).toHaveLength(0);
    expect(h.state.channels).toHaveLength(0);
    instance.dispose();
    expect(h.state.shellDisposals).toBe(1);
  });
}

test('a page without the knowledge base shell reports failure to the host shell', () => {
  const h = harness();
  h.doc.shell = false;
  const instance = startTelemetry(h.win, h.doc, h.connectShell);
  expect(h.state.readiness).toEqual(['failed']);
  expect(h.state.records).toHaveLength(0);
  instance.dispose();
});

for (const [label, options] of [
  ['no host shell', { framed: false }],
  ['missing configuration', { config: null }],
  ['disabled configuration', { config: { ...identity, enabled: false } }],
  ['incomplete configuration', { config: { enabled: true } }],
  ['missing shell channel', { channel: null }],
  ['empty shell channel', { channel: '' }],
]) {
  test(`the telemetry API is always available and inert: ${label}`, () => {
    const h = harness(options);
    const instance = startTelemetry(h.win, h.doc, h.connectShell);
    instance.telemetry.bi.track('kb-test-event');
    instance.telemetry.scenarios.start({ name: 'kb-test-scenario' }).complete();
    instance.telemetry.logging.getLogger('kb-test').warn('test message');
    expect(h.state.records).toHaveLength(0);
    expect(h.state.channels.every((channel) => channel.closed)).toBe(true);
    instance.dispose();
  });
}

test('without a deployment adapter the knowledge base never opens a channel', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, noShell);
  h.doc.dispatchEvent(new Event('astro:page-load'));
  instance.telemetry.bi.track('kb-test-event');
  expect(h.state.channels).toHaveLength(0);
  expect(h.state.records).toHaveLength(0);
  instance.dispose();
});

test('a throwing shell adapter degrades to running without a shell', () => {
  const h = harness();
  const instance = startTelemetry(h.win, h.doc, () => { throw new Error('adapter-bug'); });
  h.doc.dispatchEvent(new Event('astro:page-load'));
  expect(h.state.channels).toHaveLength(0);
  expect(h.state.warnings).toHaveLength(1);
  expect(() => instance.dispose()).not.toThrow();
});

test('a throwing shell callback does not interrupt the visit or disposal', () => {
  const h = harness();
  const failing = () => { throw new Error('adapter-bug'); };
  const instance = startTelemetry(h.win, h.doc, (win) => ({
    ...h.connectShell(win), ready: failing, dispose: failing,
  }));
  expect(h.state.records.map((record) => record.payload.eventName)).toEqual(['kb-catalog-viewed']);
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
