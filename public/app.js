const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
let state = null;
let catalog = [];
let selectedWorkflowId = null;
let draft = null;
let dirty = false;
let drag = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch]));
}
function fmtDate(value) { return value ? new Date(value).toLocaleString() : '—'; }
function statusPill(status, label = status) { return `<span class="status-pill ${escapeHtml(status || '')}">${escapeHtml(label || 'unknown')}</span>`; }
function showToast(message, timeout = 5000) {
  $('toast').textContent = message || '';
  if (message && timeout) setTimeout(() => { if ($('toast').textContent === message) $('toast').textContent = ''; }, timeout);
}

async function api(url, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, init);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `Request failed (${response.status})`);
  return body;
}

function navigate(view) {
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  const titles = { dashboard:'Dashboard', workflows:'Workflows', content:'Content', connections:'Connections', activity:'Activity' };
  $('pageTitle').textContent = titles[view] || 'Repurpose';
  location.hash = view === 'dashboard' ? '' : view;
}

function renderStats() {
  const active = state.workflows.filter((w) => w.active).length;
  const completed = state.runs.filter((r) => r.status === 'completed').length;
  const failures = state.runs.filter((r) => r.status === 'failed' || r.status === 'partial').length;
  const connected = Object.values(state.connections).filter(Boolean).length;
  $('stats').innerHTML = [
    ['Active workflows', active], ['Content detected', state.content.length], ['Completed runs', completed], ['Connected accounts', `${connected}/3`],
  ].map(([label,value]) => `<div class="stat-card"><span>${label}</span><b>${value}</b></div>`).join('');
  $('engineStatus').textContent = active ? `${active} workflow${active === 1 ? '' : 's'} active` : 'Ready · no active workflows';
  if (failures) $('engineStatus').textContent += ` · ${failures} issue${failures === 1 ? '' : 's'}`;
}

function renderDashboard() {
  renderStats();
  const active = state.workflows.filter((w) => w.active).slice(0, 5);
  $('dashboardWorkflows').innerHTML = active.length ? active.map((w) => {
    const source = w.nodes.find((n) => n.type === 'trigger');
    const dests = w.nodes.filter((n) => n.type === 'destination').map((n) => n.label).join(' + ');
    return `<div class="row-card"><div><strong>${escapeHtml(w.name)}</strong><small>${escapeHtml(source?.label || 'No trigger')} → ${escapeHtml(dests || 'No destination')}</small></div>${statusPill('ok','Active')}</div>`;
  }).join('') : '<div class="empty">No active workflows yet. Build one, connect the accounts, then turn it on.</div>';

  const recent = state.runs.slice(0, 5);
  $('dashboardActivity').innerHTML = recent.length ? recent.map(runRow).join('') : '<div class="empty">No workflow runs yet.</div>';
}

function runRow(run) {
  const workflow = state.workflows.find((w) => w.id === run.workflowId);
  const content = state.content.find((c) => c.id === run.contentId);
  return `<div class="row-card"><div><strong>${escapeHtml(workflow?.name || 'Deleted workflow')}</strong><small>${escapeHtml(content?.title || content?.caption || content?.sourceExternalId || 'Content')} · ${fmtDate(run.startedAt)}</small></div>${statusPill(run.status)}</div>`;
}

function renderWorkflowList() {
  $('workflowList').innerHTML = state.workflows.length ? state.workflows.map((w) => `
    <div class="workflow-list-item ${w.id === selectedWorkflowId ? 'active' : ''}" data-workflow-id="${w.id}">
      <div class="line"><strong>${escapeHtml(w.name)}</strong>${w.active ? statusPill('ok','On') : statusPill('','Off')}</div>
      <small>${w.nodes.filter((n) => n.type === 'destination').length} destination${w.nodes.filter((n) => n.type === 'destination').length === 1 ? '' : 's'}</small>
    </div>`).join('') : '<div class="empty">No workflows.</div>';
  document.querySelectorAll('[data-workflow-id]').forEach((el) => el.addEventListener('click', () => selectWorkflow(el.dataset.workflowId)));
}

function selectWorkflow(id) {
  const workflow = state.workflows.find((w) => w.id === id);
  if (!workflow) return;
  selectedWorkflowId = id;
  draft = clone(workflow);
  dirty = false;
  renderWorkflowList();
  renderBuilder();
}

function newWorkflow() {
  selectedWorkflowId = null;
  draft = {
    name: 'New workflow', description: '', active: false,
    nodes: [], edges: [], sourceState: { baselineComplete:false, seenIds:[] },
  };
  dirty = true;
  renderWorkflowList();
  renderBuilder();
  navigate('workflows');
}

function renderPalette() {
  const groups = { trigger:'paletteTriggers', action:'paletteActions', destination:'paletteDestinations' };
  Object.entries(groups).forEach(([type, elementId]) => {
    $(elementId).innerHTML = catalog.filter((item) => item.type === type).map((item) => `
      <button class="palette-item" data-add-node="${escapeHtml(item.key)}" ${item.enabled ? '' : 'disabled'}>
        <b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.enabled ? item.description : 'Coming later')}</span>
      </button>`).join('');
  });
  document.querySelectorAll('[data-add-node]').forEach((el) => el.addEventListener('click', () => addNode(el.dataset.addNode)));
}

function addNode(key) {
  if (!draft) newWorkflow();
  const def = catalog.find((item) => item.key === key);
  if (!def || !def.enabled) return;
  if (def.type === 'trigger' && draft.nodes.some((n) => n.type === 'trigger')) {
    showToast('A workflow can have one trigger. Remove the current trigger first.');
    return;
  }
  if (draft.nodes.some((n) => n.key === key) && def.type !== 'action') {
    showToast(`${def.label} is already in this workflow.`);
    return;
  }
  const suffix = Math.random().toString(36).slice(2, 7);
  draft.nodes.push({ id:`node_${suffix}`, type:def.type, key:def.key, label:def.label, x:80, y:100, config:{} });
  autoArrange(false);
  dirty = true;
  renderBuilder();
}

function deleteNode(id) {
  draft.nodes = draft.nodes.filter((n) => n.id !== id);
  draft.edges = draft.edges.filter((e) => e.from !== id && e.to !== id);
  rebuildEdges();
  dirty = true;
  renderBuilder();
}

function rebuildEdges() {
  if (!draft) return;
  const trigger = draft.nodes.find((n) => n.type === 'trigger');
  const actions = draft.nodes.filter((n) => n.type === 'action').sort((a,b) => a.x - b.x || a.y - b.y);
  const destinations = draft.nodes.filter((n) => n.type === 'destination');
  const edges = [];
  let previous = trigger;
  for (const action of actions) {
    if (previous) edges.push({ id:`edge_${previous.id}_${action.id}`, from:previous.id, to:action.id });
    previous = action;
  }
  if (previous) for (const destination of destinations) edges.push({ id:`edge_${previous.id}_${destination.id}`, from:previous.id, to:destination.id });
  draft.edges = edges;
}

function autoArrange(render = true) {
  if (!draft) return;
  const trigger = draft.nodes.find((n) => n.type === 'trigger');
  const actions = draft.nodes.filter((n) => n.type === 'action');
  const destinations = draft.nodes.filter((n) => n.type === 'destination');
  if (trigger) Object.assign(trigger, { x:70, y:220 });
  actions.forEach((node, index) => Object.assign(node, { x:320 + index * 245, y:220 }));
  const destX = 320 + actions.length * 245;
  destinations.forEach((node, index) => Object.assign(node, { x:destX, y:110 + index * 145 }));
  rebuildEdges();
  dirty = true;
  if (render) renderBuilder();
}

function renderBuilder() {
  renderPalette();
  if (!draft) {
    $('workflowName').value = '';
    $('workflowDescription').value = '';
    $('workflowActive').checked = false;
    $('nodeLayer').innerHTML = '';
    $('edgeLayer').innerHTML = '';
    $('emptyCanvas').style.display = 'grid';
    return;
  }
  $('workflowName').value = draft.name || '';
  $('workflowDescription').value = draft.description || '';
  $('workflowActive').checked = Boolean(draft.active);
  $('deleteWorkflowBtn').style.visibility = draft.id ? 'visible' : 'hidden';
  $('emptyCanvas').style.display = draft.nodes.length ? 'none' : 'grid';
  $('nodeLayer').innerHTML = draft.nodes.map((node) => {
    const def = catalog.find((item) => item.key === node.key);
    return `<div class="workflow-node ${node.type}" data-node-id="${node.id}" style="left:${Number(node.x)||0}px;top:${Number(node.y)||0}px">
      ${node.type !== 'trigger' ? '<i class="port in"></i>' : ''}<i class="port out"></i>
      <div class="node-head"><span class="node-type">${escapeHtml(node.type.toUpperCase())}</span><button class="node-delete" data-delete-node="${node.id}" title="Remove">×</button></div>
      <div class="node-body"><b>${escapeHtml(node.label)}</b><span>${escapeHtml(def?.platform || 'Node')}</span></div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-delete-node]').forEach((btn) => btn.addEventListener('click', (event) => { event.stopPropagation(); deleteNode(btn.dataset.deleteNode); }));
  document.querySelectorAll('.workflow-node').forEach((nodeEl) => nodeEl.addEventListener('pointerdown', beginDrag));
  requestAnimationFrame(renderEdges);
}

function beginDrag(event) {
  if (event.target.closest('.node-delete')) return;
  const nodeEl = event.currentTarget;
  const node = draft.nodes.find((n) => n.id === nodeEl.dataset.nodeId);
  if (!node) return;
  const canvas = $('workflowCanvas').getBoundingClientRect();
  drag = { node, nodeEl, offsetX:event.clientX - canvas.left - node.x + $('workflowCanvas').scrollLeft, offsetY:event.clientY - canvas.top - node.y + $('workflowCanvas').scrollTop };
  nodeEl.setPointerCapture(event.pointerId);
  nodeEl.addEventListener('pointermove', moveDrag);
  nodeEl.addEventListener('pointerup', endDrag, { once:true });
}
function moveDrag(event) {
  if (!drag) return;
  const canvas = $('workflowCanvas').getBoundingClientRect();
  drag.node.x = Math.max(15, event.clientX - canvas.left + $('workflowCanvas').scrollLeft - drag.offsetX);
  drag.node.y = Math.max(15, event.clientY - canvas.top + $('workflowCanvas').scrollTop - drag.offsetY);
  drag.nodeEl.style.left = `${drag.node.x}px`;
  drag.nodeEl.style.top = `${drag.node.y}px`;
  rebuildEdges(); renderEdges(); dirty = true;
}
function endDrag(event) {
  if (!drag) return;
  drag.nodeEl.removeEventListener('pointermove', moveDrag);
  try { drag.nodeEl.releasePointerCapture(event.pointerId); } catch (_) {}
  drag = null;
}

function renderEdges() {
  if (!draft) return;
  const svg = $('edgeLayer');
  svg.innerHTML = '';
  for (const edge of draft.edges || []) {
    const from = draft.nodes.find((n) => n.id === edge.from);
    const to = draft.nodes.find((n) => n.id === edge.to);
    if (!from || !to) continue;
    const x1 = Number(from.x) + 190, y1 = Number(from.y) + 40;
    const x2 = Number(to.x), y2 = Number(to.y) + 40;
    const dx = Math.max(55, Math.abs(x2 - x1) * .48);
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('class','edge-path');
    path.setAttribute('d',`M ${x1} ${y1} C ${x1+dx} ${y1}, ${x2-dx} ${y2}, ${x2} ${y2}`);
    svg.appendChild(path);
  }
}

async function saveWorkflow() {
  if (!draft) return;
  draft.name = $('workflowName').value.trim() || 'Untitled workflow';
  draft.description = $('workflowDescription').value.trim();
  draft.active = $('workflowActive').checked;
  rebuildEdges();
  try {
    const saved = draft.id
      ? await api(`/api/workflows/${draft.id}`, { method:'PUT', body:draft })
      : await api('/api/workflows', { method:'POST', body:draft });
    dirty = false;
    await loadState(false);
    selectWorkflow(saved.id);
    showToast('Workflow saved.');
  } catch (error) { showToast(error.message, 8000); }
}

async function deleteWorkflow() {
  if (!draft?.id) return;
  if (!confirm(`Delete “${draft.name}”?`)) return;
  try {
    await api(`/api/workflows/${draft.id}`, { method:'DELETE' });
    await loadState(false);
    const next = state.workflows[0];
    if (next) selectWorkflow(next.id); else newWorkflow();
    showToast('Workflow deleted.');
  } catch (error) { showToast(error.message); }
}

async function runSelectedWorkflow() {
  if (!draft?.id) { showToast('Save the workflow before running it.'); return; }
  showToast('Scanning source…', 0);
  try {
    const result = await api(`/api/workflows/${draft.id}/run`, { method:'POST', body:{} });
    if (result.baselined) showToast(`Baseline recorded for ${result.baselined} existing source posts. Future posts will run automatically.`);
    else showToast(`Scan complete. ${result.added || 0} new item${result.added === 1 ? '' : 's'} processed.`);
    await loadState(false);
    selectWorkflow(draft.id);
  } catch (error) { showToast(error.message, 9000); }
}

function renderConnections() {
  const cards = [
    { key:'tiktok', name:'TikTok', role:'Source + future destination', desc:'Detect new public videos from your connected TikTok account.', href:'/auth/tiktok' },
    { key:'youtube', name:'YouTube', role:'Source + destination', desc:'Detect new channel uploads or publish vertical videos to YouTube as Shorts.', href:'/auth/youtube' },
    { key:'facebook', name:'Facebook', role:'Source + destination', desc:'Watch a selected Facebook Page for new Reels or publish Reels to it.', href:'/auth/facebook' },
  ];
  $('connectionsGrid').innerHTML = cards.map((c) => {
    const connected = state.connections[c.key];
    const pageSelect = c.key === 'facebook' && state.facebookPages.length ? `<select id="facebookPageSelect">${state.facebookPages.map((p) => `<option value="${p.id}" ${p.id === state.selectedFacebookPageId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>` : '';
    return `<article class="connection-card"><div class="conn-top"><b>${escapeHtml(c.role)}</b>${statusPill(connected ? 'ok' : '', connected ? 'Connected' : 'Not connected')}</div><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.desc)}</p><div class="conn-actions"><a href="${c.href}"><button class="${connected ? 'secondary' : 'primary'}">${connected ? 'Reconnect' : 'Connect'}</button></a>${pageSelect}</div></article>`;
  }).join('');
  $('pollInterval').value = String(state.settings.pollIntervalMs || 300000);
  const page = $('facebookPageSelect');
  if (page) page.addEventListener('change', async () => { try { await api('/api/facebook/select',{method:'POST',body:{pageId:page.value}}); await loadState(false); showToast('Facebook Page selected.'); } catch(error){showToast(error.message);} });
}

function renderContent() {
  $('contentCount').textContent = `${state.content.length} items`;
  $('contentGrid').innerHTML = state.content.length ? state.content.map((c) => `<article class="content-card">${c.coverImageUrl ? `<img class="content-thumb" src="${escapeHtml(c.coverImageUrl)}" alt="">` : '<div class="content-thumb"></div>'}<div class="content-body"><strong>${escapeHtml(c.title || c.caption || `${c.sourcePlatform} post`)}</strong><small>${escapeHtml(c.sourcePlatform)} · ${fmtDate(c.sourceCreatedAt || c.createdAt)}${c.baseline ? ' · baseline' : ''}</small></div></article>`).join('') : '<div class="empty">Content appears here after a source workflow scans an account.</div>';
}

function renderActivity() {
  $('activityList').innerHTML = state.runs.length ? state.runs.map((run) => {
    const workflow = state.workflows.find((w) => w.id === run.workflowId);
    const content = state.content.find((c) => c.id === run.contentId);
    return `<article class="activity-card"><div class="activity-head"><div class="activity-title"><strong>${escapeHtml(workflow?.name || 'Deleted workflow')}</strong><small>${escapeHtml(content?.title || content?.caption || content?.sourceExternalId || 'Content')} · ${fmtDate(run.startedAt)}</small></div><div>${statusPill(run.status)} ${run.status === 'failed' || run.status === 'partial' ? `<button class="text-btn" data-retry-run="${run.id}">Retry</button>` : ''}</div></div><div class="node-results">${(run.nodeResults || []).map((nr) => `<span class="node-result ${nr.status}" title="${escapeHtml(nr.error || '')}">${escapeHtml(nr.label || nr.key)} · ${escapeHtml(nr.status)}</span>`).join('')}</div>${run.error ? `<p style="margin-top:9px;color:#ffafb4">${escapeHtml(run.error)}</p>` : ''}</article>`;
  }).join('') : '<div class="empty">No workflow runs yet.</div>';
  document.querySelectorAll('[data-retry-run]').forEach((btn) => btn.addEventListener('click', async () => { showToast('Retrying workflow…',0); try { await api(`/api/runs/${btn.dataset.retryRun}/retry`,{method:'POST'}); await loadState(false); showToast('Retry finished.'); } catch(error){showToast(error.message,9000);} }));
}

async function loadState(preserveDraft = true) {
  const previousId = selectedWorkflowId;
  state = await api('/api/state');
  if (!preserveDraft || !dirty) {
    if (previousId && state.workflows.some((w) => w.id === previousId)) selectedWorkflowId = previousId;
    else if (!selectedWorkflowId || !state.workflows.some((w) => w.id === selectedWorkflowId)) selectedWorkflowId = state.workflows[0]?.id || null;
    draft = selectedWorkflowId ? clone(state.workflows.find((w) => w.id === selectedWorkflowId)) : draft;
  }
  renderDashboard(); renderWorkflowList(); renderBuilder(); renderConnections(); renderContent(); renderActivity();
}

async function scanActive() {
  showToast('Scanning active workflows…',0);
  try {
    const result = await api('/api/scan',{method:'POST'});
    const count = (result.workflows || []).reduce((sum,w) => sum + Number(w.added || 0),0);
    showToast(result.skipped ? result.reason : `Scan complete. ${count} new item${count === 1 ? '' : 's'} processed.`);
    await loadState(false);
  } catch(error){ showToast(error.message,9000); }
}

function bind() {
  document.querySelectorAll('.nav-item').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.view)));
  document.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.go)));
  $('newWorkflowBtn').addEventListener('click', newWorkflow);
  $('newWorkflowTop').addEventListener('click', newWorkflow);
  $('saveWorkflowBtn').addEventListener('click', saveWorkflow);
  $('deleteWorkflowBtn').addEventListener('click', deleteWorkflow);
  $('runWorkflowBtn').addEventListener('click', runSelectedWorkflow);
  $('autoArrangeBtn').addEventListener('click', () => autoArrange(true));
  $('scanActiveBtn').addEventListener('click', scanActive);
  $('workflowName').addEventListener('input', () => { if (draft) { draft.name = $('workflowName').value; dirty = true; } });
  $('workflowDescription').addEventListener('input', () => { if (draft) { draft.description = $('workflowDescription').value; dirty = true; } });
  $('workflowActive').addEventListener('change', () => { if (draft) { draft.active = $('workflowActive').checked; dirty = true; } });
  $('saveSettingsBtn').addEventListener('click', async () => { try { await api('/api/settings',{method:'POST',body:{pollIntervalMs:Number($('pollInterval').value)}}); await loadState(false); showToast('Automation schedule saved.'); } catch(error){showToast(error.message);} });
  window.addEventListener('resize', renderEdges);
  window.addEventListener('hashchange', () => navigate((location.hash || '#dashboard').slice(1)));
}

(async function init(){
  bind();
  try {
    const catalogResponse = await api('/api/catalog'); catalog = catalogResponse.nodes || [];
    await loadState(false);
    navigate((location.hash || '#dashboard').slice(1));
  } catch(error) { showToast(error.message,0); }
  setInterval(() => { if (!dirty) loadState(true).catch(()=>{}); }, 15000);
})();
