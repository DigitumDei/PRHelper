// Draws the flow panel. Runs inside a VS Code webview; talks to the extension by message only.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EDGES = ['new', 'modified', 'removed', 'unchanged'];
  const EDGE_LABEL = { new: 'new call', modified: 'call changed', removed: 'call removed' };
  const NODE_LABEL = { new: 'new in this PR', modified: 'changed in this PR' };
  const MAX_SITES = 6;

  let last = null; // the last 'flow' message, kept so toggles can re-render
  const expanded = { callers: false, callees: false };
  let frame = 0;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.append(kid);
    }
    return el;
  }

  const send = (message) => vscode.postMessage(message);

  function activate(el, fn) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn(e);
      }
    });
  }

  // ---- pieces -------------------------------------------------------------------------------

  function bar(msg) {
    const crumbs = [];
    msg.trail.forEach((name, i) => {
      crumbs.push(
        h('button', { class: 'crumb', title: 'Go back to ' + name, onclick: () => send({ type: 'trail', index: msg.trailOffset + i }) }, name),
        h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'),
      );
    });
    crumbs.push(h('span', { class: 'crumb here' }, msg.model.focus.name));

    return h(
      'div',
      { class: 'bar' },
      h('button', { class: 'back', title: 'Back to the previous function', disabled: msg.trail.length === 0, onclick: () => send({ type: 'back' }) }, '← Back'),
      h('div', { class: 'trail' }, crumbs),
      h('div', { class: 'status', 'aria-live': 'polite' }),
      h(
        'div',
        { class: 'legend' },
        h('span', { class: 'key k-new' }, 'new call'),
        h('span', { class: 'key k-modified' }, 'call changed'),
        h('span', { class: 'key k-removed' }, 'call removed'),
      ),
      h('button', { class: 'source', title: 'Choose what to compare against', onclick: () => send({ type: 'source' }) }, msg.source || 'No comparison loaded'),
    );
  }

  function card(side, n) {
    const el = h('div', {
      class: ['card', 'edge-' + n.edge, 'node-' + n.node, n.external && 'external', n.clickable && 'clickable'].filter(Boolean).join(' '),
      'data-side': side,
      'data-edge': n.edge,
      title: n.clickable ? 'Go to ' + n.name + ' and centre the flow on it' : undefined,
    });
    if (n.clickable) activate(el, () => send({ type: 'open', id: n.id }));

    const badges = [];
    if (EDGE_LABEL[n.edge]) badges.push(h('span', { class: 'badge b-' + n.edge }, EDGE_LABEL[n.edge]));
    if (NODE_LABEL[n.node]) badges.push(h('span', { class: 'badge b-node-' + n.node }, NODE_LABEL[n.node]));

    el.append(h('div', { class: 'name' }, n.name), h('div', { class: 'where' }, n.where));
    if (badges.length) el.append(h('div', { class: 'badges' }, badges));

    if (n.sites.length) {
      const sites = h('div', { class: 'sites' }, side === 'callees' ? 'called at line ' : 'calls from line ');
      n.sites.slice(0, MAX_SITES).forEach((s, i) => {
        if (i) sites.append(', ');
        const link = h('span', { class: 'site', title: 'Go to this call' }, String(s.line));
        activate(link, (e) => {
          e.stopPropagation();
          send({ type: 'open', id: s.id });
        });
        sites.append(link);
      });
      if (n.sites.length > MAX_SITES) sites.append(' and ' + (n.sites.length - MAX_SITES) + ' more');
      el.append(sites);
    }
    return el;
  }

  function column(side, title, nodes, hidden) {
    const touched = (n) => n.edge !== 'unchanged' || n.node !== 'unchanged';
    const main = nodes.filter((n) => !n.external || touched(n));
    const outside = nodes.filter((n) => n.external && !touched(n));
    const col = h('div', { class: 'col ' + side }, h('div', { class: 'colhead' }, title + (nodes.length ? ' (' + nodes.length + ')' : '')));

    if (!nodes.length) {
      col.append(h('div', { class: 'empty' }, side === 'callers' ? 'No callers found.' : 'Calls nothing else.'));
    }
    main.forEach((n) => col.append(card(side, n)));
    if (outside.length) {
      const open = expanded[side];
      col.append(
        h(
          'button',
          {
            class: 'toggle',
            'aria-expanded': String(open),
            onclick: () => {
              expanded[side] = !open;
              render(last);
            },
          },
          (open ? 'Hide ' : 'Show ') + outside.length + ' outside this repo',
        ),
      );
      if (open) outside.forEach((n) => col.append(card(side, n)));
    }
    if (hidden) col.append(h('div', { class: 'more' }, '+' + hidden + ' more not shown'));
    return col;
  }

  function focusCard(f, note) {
    const state =
      f.change === 'new'
        ? 'New in this PR'
        : f.change === 'modified'
          ? 'Changed in this PR'
          : 'Not changed by this PR';
    const counts = f.change === 'unchanged' ? null : h('span', { class: 'counts' }, h('span', { class: 'plus' }, '+' + f.added), ' ', h('span', { class: 'minus' }, '−' + f.removed));
    return h(
      'div',
      { class: 'card focus node-' + f.change },
      h('div', { class: 'name' }, f.name),
      h('div', { class: 'where' }, f.where),
      h('div', { class: 'state' }, state, counts ? ' · ' : null, counts),
      note ? h('div', { class: 'note' }, note) : null,
    );
  }

  function edgeLayer() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'edges');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(SVG_NS, 'defs');
    for (const kind of EDGES) {
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', 'arrow-' + kind);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto');
      const tip = document.createElementNS(SVG_NS, 'path');
      tip.setAttribute('d', 'M1 1L9 5L1 9z');
      tip.setAttribute('class', 'tip e-' + kind);
      marker.append(tip);
      defs.append(marker);
    }
    svg.append(defs);
    return svg;
  }

  // ---- edges --------------------------------------------------------------------------------

  function drawEdges() {
    const graph = root.querySelector('.graph');
    const focus = graph && graph.querySelector('.card.focus');
    if (!graph || !focus) return;
    const svg = graph.querySelector('svg.edges');
    svg.querySelectorAll('path.edge').forEach((p) => p.remove());

    const g = graph.getBoundingClientRect();
    const f = focus.getBoundingClientRect();
    svg.setAttribute('width', String(g.width));
    svg.setAttribute('height', String(g.height));

    const pad = Math.min(14, f.height / 2);
    const anchorY = (cy) => Math.max(f.top + pad, Math.min(f.bottom - pad, cy)) - g.top;

    graph.querySelectorAll('.card[data-side]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const incoming = el.getAttribute('data-side') === 'callers';
      const x1 = (incoming ? r.right : f.right) - g.left;
      const x2 = (incoming ? f.left : r.left) - g.left;
      const y1 = incoming ? cy - g.top : anchorY(cy);
      const y2 = incoming ? anchorY(cy) : cy - g.top;
      const bend = Math.max(12, (x2 - x1) / 2);
      const kind = el.getAttribute('data-edge');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`);
      path.setAttribute('class', 'edge e-' + kind);
      path.setAttribute('marker-end', 'url(#arrow-' + kind + ')');
      svg.append(path);
    });
  }

  function scheduleEdges() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawEdges);
  }

  // ---- screens ------------------------------------------------------------------------------

  function render(msg) {
    last = msg;
    const m = msg.model;
    const graph = h(
      'div',
      { class: 'graph' },
      edgeLayer(),
      column('callers', 'Flows from', m.callers, m.hiddenCallers),
      h('div', { class: 'col centre' }, h('div', { class: 'colhead' }, 'You are here'), focusCard(m.focus, m.note)),
      column('callees', 'Flows to', m.callees, m.hiddenCallees),
    );
    const scroll = h('div', { class: 'scroll', onscroll: scheduleEdges }, graph);
    root.classList.remove('busy');
    root.replaceChildren(bar(msg), scroll);
    new ResizeObserver(scheduleEdges).observe(graph);
    scheduleEdges();
  }

  function message(text) {
    last = null;
    root.classList.remove('busy');
    root.replaceChildren(h('div', { class: 'hint' }, text));
  }

  function loading(name) {
    const status = root.querySelector('.status');
    if (last && status) {
      root.classList.add('busy');
      status.textContent = 'Tracing ' + name + '…';
    } else {
      message('Tracing ' + name + '…');
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'flow') {
      expanded.callers = false;
      expanded.callees = false;
      render(msg);
    } else if (msg.type === 'loading') {
      loading(msg.name);
    } else if (msg.type === 'hint') {
      message(msg.text);
    }
  });
  window.addEventListener('resize', scheduleEdges);

  send({ type: 'ready' });
})();
