const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '..', 'data');
const statePath = path.join(dataDir, 'state.json');

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

function starterWorkflow() {
  const createdAt = now();
  return {
    id: id('wf'),
    name: 'TikTok → YouTube + Facebook',
    description: 'Repurpose every new TikTok video to YouTube Shorts and Facebook Page Reels.',
    active: false,
    createdAt,
    updatedAt: createdAt,
    sourceState: { baselineComplete: false, seenIds: [] },
    nodes: [
      { id: 'trigger_tiktok', type: 'trigger', key: 'tiktok.new_video', label: 'New TikTok Video', x: 70, y: 180, config: {} },
      { id: 'action_download', type: 'action', key: 'media.download', label: 'Get Clean Video', x: 330, y: 180, config: { preferClean: true } },
      { id: 'action_caption', type: 'action', key: 'caption.preserve', label: 'Preserve Caption', x: 590, y: 180, config: {} },
      { id: 'dest_youtube', type: 'destination', key: 'youtube.short', label: 'YouTube Short', x: 850, y: 100, config: {} },
      { id: 'dest_facebook', type: 'destination', key: 'facebook.reel', label: 'Facebook Page Reel', x: 850, y: 270, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'trigger_tiktok', to: 'action_download' },
      { id: 'e2', from: 'action_download', to: 'action_caption' },
      { id: 'e3', from: 'action_caption', to: 'dest_youtube' },
      { id: 'e4', from: 'action_caption', to: 'dest_facebook' },
    ],
  };
}

function defaults() {
  return {
    version: 2,
    settings: {
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 300000),
    },
    oauth: { tiktok: null, youtube: null, facebook: null },
    facebookPages: [],
    selectedFacebookPageId: null,
    workflows: [starterWorkflow()],
    content: [],
    runs: [],
  };
}

function ensure() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify(defaults(), null, 2));
}

function migrate(raw) {
  const base = defaults();
  const state = {
    ...base,
    ...raw,
    version: 2,
    settings: { ...base.settings, ...(raw.settings || {}) },
    oauth: { ...base.oauth, ...(raw.oauth || {}) },
    facebookPages: raw.facebookPages || [],
    selectedFacebookPageId: raw.selectedFacebookPageId || null,
    workflows: Array.isArray(raw.workflows) && raw.workflows.length ? raw.workflows : base.workflows,
    content: Array.isArray(raw.content) ? raw.content : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };

  // Import v0.1 TikTok history so upgrading does not discard what was already seen.
  if (Array.isArray(raw.videos) && raw.videos.length && !state.content.length) {
    state.content = raw.videos.map((v) => ({
      id: v.id || id('content'),
      fingerprint: `tiktok:${v.tiktokId}`,
      sourcePlatform: 'tiktok',
      sourceExternalId: String(v.tiktokId),
      sourceUrl: v.tiktokUrl,
      title: v.title || '',
      caption: v.description || v.title || '',
      createdAt: v.createdAt || now(),
      sourceCreatedAt: v.tiktokCreatedAt || null,
      coverImageUrl: v.coverImageUrl || null,
      duration: v.duration || null,
      width: v.width || null,
      height: v.height || null,
      localPath: v.localPath || null,
      metrics: v.metrics || {},
      importedFromV01: true,
    }));
    const tiktokIds = raw.videos.map((v) => String(v.tiktokId)).filter(Boolean);
    for (const workflow of state.workflows) {
      if (workflow.nodes?.some((n) => n.key === 'tiktok.new_video')) {
        workflow.sourceState = { baselineComplete: true, seenIds: tiktokIds };
      }
    }
  }
  return state;
}

function read() {
  ensure();
  return migrate(JSON.parse(fs.readFileSync(statePath, 'utf8')));
}

function write(next) {
  ensure();
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
  fs.renameSync(tempPath, statePath);
  return next;
}

function update(mutator) {
  const state = read();
  const result = mutator(state) || state;
  return write(result);
}

function publicState() {
  const state = read();
  return {
    version: state.version,
    settings: state.settings,
    connections: {
      tiktok: Boolean(state.oauth.tiktok),
      youtube: Boolean(state.oauth.youtube),
      facebook: Boolean(state.oauth.facebook),
    },
    facebookPages: state.facebookPages.map(({ id, name }) => ({ id, name })),
    selectedFacebookPageId: state.selectedFacebookPageId,
    workflows: [...state.workflows].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    content: [...state.content].sort((a, b) => new Date(b.sourceCreatedAt || b.createdAt) - new Date(a.sourceCreatedAt || a.createdAt)).slice(0, 100),
    runs: [...state.runs].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 100),
  };
}

function saveWorkflow(input) {
  let saved;
  update((state) => {
    const existingIndex = input.id ? state.workflows.findIndex((w) => w.id === input.id) : -1;
    const existing = existingIndex >= 0 ? state.workflows[existingIndex] : null;
    const nextNodes = Array.isArray(input.nodes) ? input.nodes : (existing?.nodes || []);
    const oldTriggerKey = existing?.nodes?.find((n) => n.type === 'trigger')?.key || null;
    const nextTriggerKey = nextNodes.find((n) => n.type === 'trigger')?.key || null;
    saved = {
      id: existing?.id || id('wf'),
      name: String(input.name || existing?.name || 'Untitled Workflow').slice(0, 120),
      description: String(input.description || existing?.description || '').slice(0, 500),
      active: typeof input.active === 'boolean' ? input.active : Boolean(existing?.active),
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      sourceState: oldTriggerKey && oldTriggerKey !== nextTriggerKey ? { baselineComplete: false, seenIds: [] } : (existing?.sourceState || { baselineComplete: false, seenIds: [] }),
      nodes: nextNodes,
      edges: Array.isArray(input.edges) ? input.edges : (existing?.edges || []),
    };
    if (existingIndex >= 0) state.workflows[existingIndex] = saved;
    else state.workflows.push(saved);
  });
  return saved;
}

function patchWorkflow(idValue, patch) {
  let saved = null;
  update((state) => {
    const index = state.workflows.findIndex((w) => w.id === idValue);
    if (index < 0) return state;
    state.workflows[index] = { ...state.workflows[index], ...patch, updatedAt: now() };
    saved = state.workflows[index];
  });
  return saved;
}

function deleteWorkflow(idValue) {
  let deleted = false;
  update((state) => {
    const before = state.workflows.length;
    state.workflows = state.workflows.filter((w) => w.id !== idValue);
    deleted = before !== state.workflows.length;
  });
  return deleted;
}

function upsertContent(item) {
  let saved;
  update((state) => {
    const index = state.content.findIndex((c) => c.fingerprint === item.fingerprint);
    if (index >= 0) {
      state.content[index] = { ...state.content[index], ...item, updatedAt: now() };
      saved = state.content[index];
    } else {
      saved = { id: id('content'), createdAt: now(), updatedAt: now(), ...item };
      state.content.push(saved);
    }
  });
  return saved;
}

function patchContent(idValue, patch) {
  let saved = null;
  update((state) => {
    const index = state.content.findIndex((c) => c.id === idValue);
    if (index < 0) return state;
    state.content[index] = { ...state.content[index], ...patch, updatedAt: now() };
    saved = state.content[index];
  });
  return saved;
}

function createRun({ workflowId, contentId, triggerNodeId }) {
  const run = {
    id: id('run'), workflowId, contentId, triggerNodeId,
    status: 'running', startedAt: now(), finishedAt: null,
    nodeResults: [], error: null,
  };
  update((state) => {
    state.runs.push(run);
    if (state.runs.length > 2000) state.runs = state.runs.slice(-2000);
    return state;
  });
  return run;
}

function patchRun(idValue, patch) {
  let saved = null;
  update((state) => {
    const index = state.runs.findIndex((r) => r.id === idValue);
    if (index < 0) return state;
    state.runs[index] = { ...state.runs[index], ...patch };
    saved = state.runs[index];
  });
  return saved;
}

function appendNodeResult(runId, result) {
  let saved = null;
  update((state) => {
    const run = state.runs.find((r) => r.id === runId);
    if (!run) return state;
    run.nodeResults.push(result);
    saved = run;
  });
  return saved;
}

module.exports = {
  read, write, update, publicState,
  saveWorkflow, patchWorkflow, deleteWorkflow,
  upsertContent, patchContent,
  createRun, patchRun, appendNodeResult,
};
