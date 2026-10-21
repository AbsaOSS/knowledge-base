// A hand-built search index that exercises every MCP code path the generated fixture search index
// cannot reach: several apps and tags, anchored sections, a document long enough for
// offset paging, a surrogate pair on a slice boundary, and compound/misspelled terms.
// Deterministic by construction — the golden outputs in ./golden depend on every byte.

const section = (text, heading, anchor, level) => {
  const start = text.indexOf(`${'#'.repeat(level)} ${heading}`);
  return { heading, anchor, level, start };
};

function document({ uri, app, title, description, tags, text, headings = [] }) {
  const sections = headings.map(([heading, anchor, level]) => section(text, heading, anchor, level));
  sections.forEach((item, i) => { item.end = i + 1 < sections.length ? sections[i + 1].start : text.length; });
  return {
    uri, app, route: `/knowledge-base/${uri.slice('kb://'.length)}/`, title, description, tags,
    section: null, mimeType: 'text/markdown', sourceVersion: 'v1.2.3', sha256: 'f'.repeat(64),
    size: Buffer.byteLength(text), truncated: false, text, sections,
  };
}

// ~60k characters; the emoji straddles index 20000, which read_document must not split.
const longBody = (() => {
  const words = Array.from({ length: 9000 }, (_, i) => `token${i % 97}`).join(' ');
  const head = '# Operations handbook\n\nThe operations handbook covers incident response and on-call rotation.\n\n## Incident response\n\n';
  const pad = words.slice(0, 19999 - head.length);
  return `${head}${pad}\u{1F600}${words}\n\n## On-call rotation\n\nOn-call engineers rotate weekly and hand over every Monday.`;
})();

const documents = [
  document({
    uri: 'kb://eventbus', app: 'eventbus', title: 'Event Bus', tags: ['events'],
    description: 'EventBus is the platform for publishing and consuming domain events.',
    text: '# Event Bus\n\nEventBus is the platform for publishing and consuming domain events.\n\n## Publishing\n\nPublish events with the producer client and a registered schema.\n\n## Consuming\n\nConsumers subscribe to topics and acknowledge each delivery.',
    headings: [['Event Bus', 'event-bus', 1], ['Publishing', 'publishing', 2], ['Consuming', null, 2]],
  }),
  document({
    uri: 'kb://eventbus/schemas', app: 'eventbus', title: 'Schema registry', tags: ['events', 'reference'],
    description: 'Register and evolve event schemas without breaking consumers.',
    text: '# Schema registry\n\nRegister and evolve event schemas without breaking consumers.\n\n## Compatibility\n\nBackward compatible changes add optional fields only.',
    headings: [['Schema registry', 'schema-registry', 1], ['Compatibility', 'compatibility', 2]],
  }),
  document({
    uri: 'kb://service-accounts/password-rotation', app: 'service-accounts', title: 'Rotating service account passwords', tags: ['identity'],
    description: 'Rotate passwords for service accounts with a staged credential rollout.',
    text: '# Rotating service account passwords\n\nRotate passwords for service accounts with a staged credential rollout.\n\n## Prerequisites\n\nYou need the vault operator role.\n\n## Rotation\n\nGenerate the new credential, deploy it, then revoke the old one.',
    headings: [['Rotating service account passwords', 'rotating', 1], ['Prerequisites', 'prerequisites', 2], ['Rotation', 'rotation', 2]],
  }),
  document({
    uri: 'kb://service-accounts/ops/handbook', app: 'service-accounts', title: 'Operations handbook', tags: ['operations'],
    description: 'The operations handbook covers incident response and on-call rotation.',
    text: longBody,
    headings: [['Operations handbook', 'handbook', 1], ['Incident response', 'incident-response', 2], ['On-call rotation', 'on-call', 2]],
  }),
  document({
    uri: 'kb://agentic-toolkit/skills/aquasec-suppress', app: 'agentic-toolkit', title: 'AquaSec suppress', tags: ['security', 'automation'],
    description: 'Generate an AquaSec suppression report from scan findings.',
    text: '# AquaSec suppress\n\nGenerate an AquaSec suppression report from scan findings.\n\n## Configuration\n\nInstall the skill and configure report settings.\n\n## Usage\n\nUse the prompt examples to generate and review suppression reports.',
    headings: [['AquaSec suppress', 'aquasec-suppress', 1], ['Configuration', 'configuration', 2], ['Usage', 'usage', 2]],
  }),
  document({
    uri: 'kb://agentic-toolkit/skills/release-notes', app: 'agentic-toolkit', title: 'Release notes writer', tags: ['automation'],
    description: 'Draft release notes from merged pull requests and conventional commits.',
    text: '# Release notes writer\n\nDraft release notes from merged pull requests and conventional commits.\n\n## Release process\n\nRun the skill after tagging; it groups changes by type.',
    headings: [['Release notes writer', 'release-notes', 1], ['Release process', 'release-process', 2]],
  }),
  document({
    uri: 'kb://external', app: 'external', title: 'External Docs', tags: ['external'],
    description: 'Hosted elsewhere.',
    text: '# External Docs\n\nHosted elsewhere.\n\nExternal documentation: https://example.com/docs',
  }),
];

export const syntheticIndex = {
  schemaVersion: 1,
  generator: 'knowledge-base@1.0.0',
  indexedAt: '2026-01-01T00:00:00.000Z',
  pathPrefix: 'knowledge-base',
  contentHash: 'synthetic-golden-v1',
  apps: [
    { slug: 'agentic-toolkit', name: 'Agentic Toolkit', description: 'Automation skills for engineers.', tags: ['automation'], kind: 'artifact', url: null, sourceVersion: 'v1.2.3' },
    { slug: 'eventbus', name: 'Event Bus', description: 'Event platform documentation.', tags: ['events'], kind: 'artifact', url: null, sourceVersion: 'v1.2.3' },
    { slug: 'external', name: 'External Docs', description: 'Hosted elsewhere.', tags: ['external'], kind: 'iframe', url: 'https://example.com/docs', sourceVersion: null },
    { slug: 'service-accounts', name: 'Service Accounts', description: 'Service account operations.', tags: ['identity'], kind: 'artifact', url: null, sourceVersion: 'v1.2.3' },
  ],
  documents,
};
