const crypto = require('crypto');
const store = require('../store');
const tiktok = require('./tiktok');
const { downloadSource } = require('./downloader');
const youtube = require('./youtube');
const facebook = require('./facebook');

let scanRunning = false;
let timer = null;

function now() { return new Date().toISOString(); }

function normalizeTikTok(item) {
  return {
    fingerprint: `tiktok:${String(item.id)}`,
    sourcePlatform: 'tiktok',
    sourceExternalId: String(item.id),
    sourceUrl: item.share_url,
    title: item.title || '',
    caption: item.video_description || item.title || '',
    sourceCreatedAt: item.create_time ? new Date(item.create_time * 1000).toISOString() : null,
    duration: item.duration || null,
    width: item.width || null,
    height: item.height || null,
    coverImageUrl: item.cover_image_url || null,
    metrics: {
      likes: item.like_count || 0,
      comments: item.comment_count || 0,
      shares: item.share_count || 0,
      views: item.view_count || 0,
    },
  };
}

function platformForNodeKey(key) {
  if (String(key).startsWith('tiktok.')) return 'tiktok';
  if (String(key).startsWith('youtube.')) return 'youtube';
  if (String(key).startsWith('facebook.')) return 'facebook';
  return null;
}

async function fetchSourceItems(triggerKey) {
  if (triggerKey === 'tiktok.new_video') {
    return (await tiktok.listVideos()).map(normalizeTikTok).filter((item) => item.sourceUrl);
  }
  if (triggerKey === 'youtube.new_video') {
    return (await youtube.listRecentUploads()).filter((item) => item.sourceUrl);
  }
  if (triggerKey === 'facebook.new_reel') {
    return (await facebook.listReels()).filter((item) => item.sourceUrl);
  }
  throw new Error(`Source trigger “${triggerKey}” is not implemented.`);
}

function validateWorkflow(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    throw new Error('Workflow nodes and edges are required.');
  }
  const triggers = workflow.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) throw new Error('A workflow must contain exactly one trigger.');
  if (!workflow.nodes.some((n) => n.type === 'destination')) throw new Error('A workflow needs at least one destination.');

  const ids = new Set(workflow.nodes.map((n) => n.id));
  if (ids.size !== workflow.nodes.length) throw new Error('Workflow node IDs must be unique.');
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error('Workflow contains an edge connected to a missing node.');
    if (edge.from === edge.to) throw new Error('A workflow node cannot connect to itself.');
  }

  topologicalOrder(workflow); // Detect cycles.

  const triggerPlatform = platformForNodeKey(triggers[0].key);
  for (const destination of workflow.nodes.filter((n) => n.type === 'destination')) {
    if (!hasPathFromTrigger(workflow, destination.id)) {
      throw new Error(`Destination “${destination.label}” is not connected to the trigger.`);
    }
    const destinationPlatform = platformForNodeKey(destination.key);
    if (triggerPlatform && destinationPlatform === triggerPlatform) {
      throw new Error('A workflow cannot publish back to the same platform that triggered it.');
    }
  }
  return true;
}

function topologicalOrder(workflow) {
  const indegree = new Map(workflow.nodes.map((n) => [n.id, 0]));
  const next = new Map(workflow.nodes.map((n) => [n.id, []]));
  for (const edge of workflow.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    next.get(edge.from)?.push(edge.to);
  }
  const queue = workflow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const ordered = [];
  while (queue.length) {
    const current = queue.shift();
    ordered.push(current);
    for (const child of next.get(current) || []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (ordered.length !== workflow.nodes.length) throw new Error('Workflow contains a cycle.');
  return ordered.map((id) => workflow.nodes.find((n) => n.id === id));
}

function hasPathFromTrigger(workflow, nodeId) {
  const trigger = workflow.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return false;
  const next = new Map(workflow.nodes.map((n) => [n.id, []]));
  for (const edge of workflow.edges) next.get(edge.from)?.push(edge.to);
  const seen = new Set([trigger.id]);
  const queue = [trigger.id];
  while (queue.length) {
    const current = queue.shift();
    if (current === nodeId) return true;
    for (const child of next.get(current) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return false;
}

async function executeNode(node, context) {
  switch (node.key) {
    case 'media.download': {
      if (context.localPath) return { localPath: context.localPath, reused: true };
      return { localPath: await downloadSource(context) };
    }
    case 'caption.preserve':
      return { caption: context.caption || context.title || '' };
    case 'caption.strip_source_tags': {
      const caption = String(context.caption || '')
        .replace(/#(?:tiktok|fyp|foryou|foryoupage)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return { caption };
    }
    case 'youtube.short': {
      if (!context.localPath) throw new Error('YouTube destination requires a downloaded video. Add a Get Clean Video step before it.');
      return youtube.uploadShort({ ...context, description: context.caption });
    }
    case 'facebook.reel': {
      if (!context.localPath) throw new Error('Facebook destination requires a downloaded video. Add a Get Clean Video step before it.');
      return facebook.uploadReel({ ...context, description: context.caption });
    }
    default:
      throw new Error(`Node type “${node.key}” is not executable in this version.`);
  }
}

async function runWorkflow(workflowId, contentId, options = {}) {
  const state = store.read();
  const workflow = state.workflows.find((w) => w.id === workflowId);
  const content = state.content.find((c) => c.id === contentId);
  if (!workflow) throw new Error('Workflow not found.');
  if (!content) throw new Error('Content not found.');
  validateWorkflow(workflow);

  if (!options.force) {
    const already = state.runs.find((r) =>
      r.workflowId === workflowId &&
      r.contentId === contentId &&
      ['running', 'completed', 'partial'].includes(r.status)
    );
    if (already) return already;
  }

  const trigger = workflow.nodes.find((n) => n.type === 'trigger');
  const run = store.createRun({ workflowId, contentId, triggerNodeId: trigger.id });
  const context = { ...content };
  const failures = [];
  const ordered = topologicalOrder(workflow);

  store.appendNodeResult(run.id, {
    nodeId: trigger.id,
    key: trigger.key,
    label: trigger.label,
    status: 'completed',
    startedAt: now(),
    finishedAt: now(),
    output: { sourceExternalId: content.sourceExternalId },
  });

  for (const node of ordered) {
    if (node.type === 'trigger' || !hasPathFromTrigger(workflow, node.id)) continue;
    if (node.type === 'destination' && Array.isArray(options.destinationNodeIds) && !options.destinationNodeIds.includes(node.id)) continue;

    const startedAt = now();
    try {
      const output = await executeNode(node, context);
      Object.assign(context, output || {});
      if (output?.localPath) store.patchContent(contentId, { localPath: output.localPath });
      store.appendNodeResult(run.id, {
        nodeId: node.id,
        key: node.key,
        label: node.label,
        status: 'completed',
        startedAt,
        finishedAt: now(),
        output: output || {},
      });
    } catch (error) {
      failures.push({ nodeId: node.id, key: node.key, message: error.message });
      store.appendNodeResult(run.id, {
        nodeId: node.id,
        key: node.key,
        label: node.label,
        status: 'failed',
        startedAt,
        finishedAt: now(),
        error: error.message,
      });
      // A processing failure blocks downstream nodes. A destination failure should not block siblings.
      if (node.type !== 'destination') break;
    }
  }

  const nodeResults = store.read().runs.find((r) => r.id === run.id)?.nodeResults || [];
  const targetDestinationIds = Array.isArray(options.destinationNodeIds)
    ? options.destinationNodeIds
    : workflow.nodes.filter((n) => n.type === 'destination' && hasPathFromTrigger(workflow, n.id)).map((n) => n.id);
  const successfulDestinations = nodeResults.filter((r) => r.status === 'completed' && targetDestinationIds.includes(r.nodeId)).length;
  const destinationCount = targetDestinationIds.length;

  let status = 'completed';
  if (failures.length && successfulDestinations) status = 'partial';
  else if (failures.length) status = 'failed';
  else if (successfulDestinations < destinationCount) status = 'partial';

  return store.patchRun(run.id, {
    status,
    finishedAt: now(),
    error: failures[0]?.message || null,
  });
}

function markWorkflowSeen(workflowId, externalIds, baselineComplete = true) {
  store.update((state) => {
    const workflow = state.workflows.find((w) => w.id === workflowId);
    if (!workflow) return state;
    const current = new Set(workflow.sourceState?.seenIds || []);
    externalIds.forEach((x) => current.add(String(x)));
    workflow.sourceState = {
      baselineComplete,
      seenIds: Array.from(current).slice(-2000),
    };
    workflow.updatedAt = now();
    return state;
  });
}

async function scanWorkflow(workflowId, { forceProcessExisting = false } = {}) {
  const workflow = store.read().workflows.find((w) => w.id === workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  validateWorkflow(workflow);

  const trigger = workflow.nodes.find((n) => n.type === 'trigger');
  const items = await fetchSourceItems(trigger.key);
  const ordered = [...items].sort((a, b) => new Date(a.sourceCreatedAt || 0) - new Date(b.sourceCreatedAt || 0));
  const sourceState = workflow.sourceState || { baselineComplete: false, seenIds: [] };
  const seen = new Set(sourceState.seenIds || []);

  if (!sourceState.baselineComplete && !forceProcessExisting) {
    const ids = [];
    for (const normalized of ordered) {
      if (!normalized.sourceUrl) continue;
      store.upsertContent({ ...normalized, baseline: true });
      ids.push(normalized.sourceExternalId);
    }
    markWorkflowSeen(workflowId, ids, true);
    return { workflowId, found: ordered.length, added: 0, baselined: ids.length, runs: [] };
  }

  const runs = [];
  let added = 0;
  for (const normalized of ordered) {
    if (!normalized.sourceUrl) continue;
    if (seen.has(normalized.sourceExternalId) && !forceProcessExisting) continue;
    const content = store.upsertContent(normalized);
    markWorkflowSeen(workflowId, [normalized.sourceExternalId], true);
    seen.add(normalized.sourceExternalId);
    added += 1;
    runs.push(await runWorkflow(workflowId, content.id, { force: forceProcessExisting }));
  }

  return { workflowId, found: ordered.length, added, baselined: 0, runs };
}

async function scanActiveWorkflows() {
  if (scanRunning) return { skipped: true, reason: 'scan already running' };
  scanRunning = true;
  try {
    const active = store.read().workflows.filter((w) => w.active);
    if (!active.length) return { skipped: false, workflows: [] };

    const sourceCache = new Map();
    const summaries = [];

    for (const workflow of active) {
      validateWorkflow(workflow);
      const trigger = workflow.nodes.find((n) => n.type === 'trigger');
      let ordered = sourceCache.get(trigger.key);
      if (!ordered) {
        const items = await fetchSourceItems(trigger.key);
        ordered = [...items].sort((a, b) => new Date(a.sourceCreatedAt || 0) - new Date(b.sourceCreatedAt || 0));
        sourceCache.set(trigger.key, ordered);
      }

      const sourceState = workflow.sourceState || { baselineComplete: false, seenIds: [] };
      const seen = new Set(sourceState.seenIds || []);

      if (!sourceState.baselineComplete) {
        const ids = [];
        for (const normalized of ordered) {
          if (!normalized.sourceUrl) continue;
          store.upsertContent({ ...normalized, baseline: true });
          ids.push(normalized.sourceExternalId);
        }
        markWorkflowSeen(workflow.id, ids, true);
        summaries.push({ workflowId: workflow.id, found: ordered.length, added: 0, baselined: ids.length });
        continue;
      }

      let added = 0;
      for (const normalized of ordered) {
        if (!normalized.sourceUrl || seen.has(normalized.sourceExternalId)) continue;
        const content = store.upsertContent(normalized);
        markWorkflowSeen(workflow.id, [normalized.sourceExternalId], true);
        seen.add(normalized.sourceExternalId);
        added += 1;
        await runWorkflow(workflow.id, content.id);
      }
      summaries.push({ workflowId: workflow.id, found: ordered.length, added, baselined: 0 });
    }

    return { skipped: false, workflows: summaries };
  } finally {
    scanRunning = false;
  }
}

async function retryRun(runId) {
  const state = store.read();
  const oldRun = state.runs.find((r) => r.id === runId);
  if (!oldRun) throw new Error('Run not found.');
  const workflow = state.workflows.find((w) => w.id === oldRun.workflowId);
  if (!workflow) throw new Error('Workflow not found.');

  const failed = (oldRun.nodeResults || []).filter((result) => result.status === 'failed');
  const failedProcessingNode = failed.some((result) => workflow.nodes.find((n) => n.id === result.nodeId)?.type !== 'destination');
  if (failedProcessingNode) return runWorkflow(oldRun.workflowId, oldRun.contentId, { force: true });

  const failedDestinationIds = failed
    .map((result) => result.nodeId)
    .filter((nodeId) => workflow.nodes.find((n) => n.id === nodeId)?.type === 'destination');
  if (!failedDestinationIds.length) return oldRun;

  return runWorkflow(oldRun.workflowId, oldRun.contentId, {
    force: true,
    destinationNodeIds: failedDestinationIds,
  });
}

function schedule() {
  if (timer) clearInterval(timer);
  const interval = Math.max(60000, Number(store.read().settings.pollIntervalMs || 300000));
  timer = setInterval(() => {
    scanActiveWorkflows().catch((error) => console.error('[workflow-engine]', error.message));
  }, interval);
  timer.unref?.();
}

function workflowFingerprint(workflow) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }))
    .digest('hex');
}

module.exports = {
  validateWorkflow,
  topologicalOrder,
  runWorkflow,
  scanWorkflow,
  scanActiveWorkflows,
  retryRun,
  schedule,
  workflowFingerprint,
};
