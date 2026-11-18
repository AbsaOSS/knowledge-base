// Test-only shell receiver: the core broadcast host a shell runs, over a
// per-tab channel, with a recording sink. Pairs with tests/fixtures/shell/kb-shell.mjs.
import {
  UwtTelemetryBroadcastHost,
  UwtTelemetrySink,
} from '@absaoss-cps/ui-watchtower';

const channelName = `kb-test-${crypto.randomUUID()}`;
window.__kbTestShell = { channelName };
const state = window.__kbTelemetryTest = { events: [], readiness: [] };

class RecordingSink extends UwtTelemetrySink {
  record(eventType, payload, metadata) { state.events.push({ kind: 'event', eventType, payload, metadata }); }
  recordError() {}
  getSessionId() { return undefined; }
  setUserId() {}
  getUserId() { return undefined; }
  flush() {}
}
const host = new UwtTelemetryBroadcastHost({
  channelName,
  sink: new RecordingSink(),
  logApi: { send: (record) => state.events.push({ kind: 'log', record }), query: async () => [] },
});

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'kb-test-shell' ||
      ![...document.querySelectorAll('iframe[name="wf:knowledge-base"]')]
        .some((frame) => frame.contentWindow === event.source)) return;
  state.readiness.push(event.data.status);
});
window.addEventListener('unload', () => host.dispose(), { once: true });
