// The admin UI, as one self-contained page.
//
// Inlined as a string rather than shipped as a file next to the source: the
// service runs under ts-node straight from the image, so there is no build step
// that would copy a .html asset, and resolving a path relative to __dirname is
// one more thing that breaks differently in the container than on a laptop.
//
// No external requests of any kind — no CDN, no font, no analytics. That is
// what lets the Content-Security-Policy in admin.ts be as narrow as it is.

export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>feedgen admin</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68; --line: #e2e2df;
    --card: #ffffff; --accent: #2563eb; --ok: #157f3d; --warn: #9a6700; --bad: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a; --fg: #e8e8e6; --muted: #9a9a97; --line: #2c2e31;
      --card: #1e2022; --accent: #6ea8fe; --ok: #4ec27f; --warn: #e0b341; --bad: #ff6b5e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem 1rem 3rem; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; margin: 0; letter-spacing: .01em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 2rem 0 .6rem; font-weight: 600; }
  header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap;
           border-bottom: 1px solid var(--line); padding-bottom: .9rem; }
  header .spacer { flex: 1; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .pad { padding: .9rem 1rem; }
  .grid { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
  .kv { display: flex; justify-content: space-between; gap: 1rem; padding: .3rem 0; }
  .kv + .kv { border-top: 1px dashed var(--line); }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; text-align: right; word-break: break-word; }
  dl { margin: 0; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: .78rem;
       text-transform: uppercase; letter-spacing: .05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .wrap { overflow-x: auto; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px;
          font-size: .75rem; font-weight: 600; border: 1px solid currentColor; }
  .pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); } .pill.bad { color: var(--bad); }
  button {
    font: inherit; padding: .45rem .9rem; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  input[type=password] {
    font: inherit; width: 100%; padding: .55rem .7rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  form.login { max-width: 21rem; margin: 4rem auto; }
  form.login p { color: var(--muted); font-size: .85rem; margin: .2rem 0 1rem; }
  .row { display: flex; gap: .5rem; align-items: center; margin-top: .7rem; }
  .err { color: var(--bad); font-size: .85rem; min-height: 1.2em; margin-top: .6rem; }
  .muted { color: var(--muted); }
  .small { font-size: .82rem; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
</style>
</head>
<body>
<main id="app"><p class="muted">Loading…</p></main>

<script>
(function () {
  var app = document.getElementById('app');

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }
  function kv(label, value, cls) {
    var dd = h('dd', { text: value == null ? '—' : String(value) });
    if (cls) dd.className = cls;
    return h('div', { class: 'kv' }, [h('dt', { text: label }), dd]);
  }
  // The page is served both at /admin and /admin/, and a relative fetch would
  // resolve to /api/... in the first case. Anchor every call to the mount point.
  var base = location.pathname.replace(/\\/+$/, '') + '/';

  function api(path, body) {
    return fetch(base + 'api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
  }
  function ago(sec) {
    if (sec == null) return '—';
    var s = Math.abs(sec), sign = sec < 0 ? '-' : '';
    if (s < 90) return sign + s + 's';
    if (s < 5400) return sign + Math.round(s / 60) + 'm';
    if (s < 172800) return sign + Math.round(s / 3600) + 'h';
    return sign + Math.round(s / 86400) + 'd';
  }
  function since(iso) {
    if (!iso) return '—';
    return ago(Math.round((Date.now() - Date.parse(iso)) / 1000)) + ' ago';
  }

  function renderLogin(message) {
    app.innerHTML = '';
    var input = h('input', { type: 'password', autocomplete: 'current-password',
                             'aria-label': 'Admin password' });
    var err = h('div', { class: 'err', text: message || '' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'login card pad' }, [
      h('h1', { text: 'feedgen admin' }),
      h('p', { text: 'Config and status for the feed generator.' }),
      input, h('div', { class: 'row' }, [btn]), err
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      api('login', { password: input.value }).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        btn.disabled = false;
        if (res.status === 200) { input.value = ''; load(); }
        else { err.textContent = res.body.error || 'Sign-in failed'; input.select(); }
      }).catch(function () {
        btn.disabled = false; err.textContent = 'Network error';
      });
    });
    app.appendChild(form);
    input.focus();
  }

  function renderStatus(s) {
    app.innerHTML = '';

    var writable = s.service.writable;
    var boxPill = h('span', {
      class: 'pill ' + (writable ? 'ok' : 'warn'),
      text: writable ? 'primary — edits allowed' : 'read-only'
    });
    var logout = h('button', { text: 'Sign out' });
    logout.addEventListener('click', function () {
      api('logout', {}).then(function () { renderLogin('Signed out.'); });
    });
    var refresh = h('button', { text: 'Refresh' });
    refresh.addEventListener('click', function () { load(); });

    app.appendChild(h('header', {}, [
      h('h1', { text: 'feedgen admin' }),
      h('span', { class: 'mono muted', text: s.box.name }),
      boxPill,
      h('span', { class: 'spacer' }, []),
      refresh, logout
    ]));

    // ── service identity
    app.appendChild(h('h2', { text: 'Service' }));
    app.appendChild(h('div', { class: 'grid' }, [
      h('div', { class: 'card pad' }, [h('dl', {}, [
        kv('Hostname', s.service.hostname),
        kv('Port', s.service.port),
        kv('Process up', ago(s.box.processUptimeSec)),
        kv('Host up', ago(s.box.uptimeSec))
      ])]),
      h('div', { class: 'card pad' }, [h('dl', {}, [
        kv('Service DID', s.service.serviceDid, 'mono small'),
        kv('Publisher DID', s.service.publisherDid, 'mono small'),
        kv('Node', s.box.node, 'mono small'),
        kv('PID', s.box.pid)
      ])])
    ]));

    // ── ingest
    app.appendChild(h('h2', { text: 'Ingest' }));
    var cursorCards = s.cursors.map(function (c) {
      var cls = c.lagSec == null ? '' : c.lagSec > 900 ? 'bad' : c.lagSec > 120 ? 'warn' : 'ok';
      return h('div', { class: 'card pad' }, [h('dl', {}, [
        kv('Endpoint', c.service.replace(/^wss?:\\/\\//, ''), 'mono small'),
        kv('Behind by', ago(c.lagSec), 'pill ' + cls),
        kv('Cursor at', c.at ? c.at.replace('T', ' ').replace('.000Z', 'Z') : '—', 'mono small')
      ])]);
    });
    if (!cursorCards.length) {
      cursorCards = [h('div', { class: 'card pad muted', text: 'No cursor recorded yet.' })];
    }
    app.appendChild(h('div', { class: 'grid' }, cursorCards));

    // ── feeds
    app.appendChild(h('h2', { text: 'Feeds' }));
    var head = h('tr', {}, [
      h('th', { text: 'rkey' }), h('th', { text: 'Name' }),
      h('th', { class: 'num', text: 'Posts' }), h('th', { text: 'Retention' }),
      h('th', { class: 'num', text: 'Inc' }), h('th', { class: 'num', text: 'Exc' }),
      h('th', { class: 'num', text: 'DIDs' }), h('th', { text: 'Oldest' }),
      h('th', { text: 'Newest' }), h('th', { text: 'Pin' })
    ]);
    var body = s.feeds.map(function (f) {
      var name = h('td', {}, []);
      name.appendChild(document.createTextNode(f.displayName || '—'));
      if (!f.routed) {
        name.appendChild(document.createTextNode(' '));
        name.appendChild(h('span', { class: 'pill bad', text: 'not routed' }));
      }
      return h('tr', {}, [
        h('td', { class: 'mono', text: f.key }),
        name,
        h('td', { class: 'num', text: String(f.rows) }),
        h('td', { text: f.retention ? f.retention.value + ' ' + f.retention.type : '—' }),
        h('td', { class: 'num', text: String(f.includePatterns) }),
        h('td', { class: 'num', text: String(f.excludePatterns) }),
        h('td', { class: 'num', text: String(f.includeDids) }),
        h('td', { class: 'small muted', text: since(f.oldest) }),
        h('td', { class: 'small muted', text: since(f.newest) }),
        h('td', { class: 'small', text: f.pinnedPost ? 'yes' : '—' })
      ]);
    });
    app.appendChild(h('div', { class: 'card wrap' }, [
      h('table', {}, [h('thead', {}, [head]), h('tbody', {}, body)])
    ]));

    // ── config file
    app.appendChild(h('h2', { text: 'Config' }));
    app.appendChild(h('div', { class: 'card pad' }, [h('dl', {}, [
      kv('File', s.filters.path, 'mono small'),
      kv('Digest', s.filters.sha256 || 'unreadable', 'mono small'),
      kv('Modified', s.filters.modified ? since(s.filters.modified) : '—'),
      kv('Size', s.filters.sizeBytes == null ? '—' : s.filters.sizeBytes + ' B')
    ])]));

    app.appendChild(h('footer', {
      text: 'Read-only view. Generated ' + s.generatedAt.replace('T', ' ').slice(0, 19) + 'Z'
    }));
  }

  var timer = null;
  function load() {
    if (timer) { clearTimeout(timer); timer = null; }
    api('status').then(function (r) {
      if (r.status === 401) { renderLogin(); return; }
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json().then(function (b) {
        renderStatus(b.status);
        timer = setTimeout(load, 30000);
      });
    }).catch(function (e) {
      app.innerHTML = '';
      app.appendChild(h('div', { class: 'card pad' }, [
        h('p', { class: 'err', text: 'Could not load status: ' + e.message })
      ]));
      timer = setTimeout(load, 30000);
    });
  }

  load();
})();
</script>
</body>
</html>
`
