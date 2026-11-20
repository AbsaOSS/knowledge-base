// Test shell adapter: what a deployment supplies as kb-shell.mjs, for the
// harness host in tests/host/. Detects the harness's same-origin fragment frame
// and reports readiness to it with a plain postMessage.
export function connectShell(win) {
  try {
    if (win.name !== 'wf:knowledge-base' || win.parent === win ||
        win.parent.location.origin !== win.location.origin) return null;
  } catch {
    return null;
  }
  const report = (status) => win.parent.postMessage({ type: 'kb-test-shell', status }, win.location.origin);
  return {
    channelName: win.parent.__kbTestShell?.channelName,
    ready: () => report('ready'),
    failed: () => report('failed'),
    dispose() {},
  };
}
