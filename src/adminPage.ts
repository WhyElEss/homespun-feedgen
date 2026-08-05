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
  .pill.idle { color: var(--muted); }
  /* A cursor left behind by an endpoint switch: still worth showing, but it
     must not compete for attention with the one that is actually running. */
  .card.inactive { opacity: .65; }
  .card.inactive .note { margin: .6rem 0 0; padding-top: .5rem;
                         border-top: 1px dashed var(--line); }
  button {
    font: inherit; padding: .45rem .9rem; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  input[type=password], input[type=text] {
    font: inherit; width: 100%; padding: .55rem .7rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  /* Present for password managers, not for the operator: it carries no meaning
     and cannot be changed, so it should not look like something to fill in. */
  form.login input { margin-bottom: .5rem; }
  .hidden { display: none; }
  form.login { max-width: 21rem; margin: 4rem auto; }
  form.login p { color: var(--muted); font-size: .85rem; margin: .2rem 0 1rem; }
  .row { display: flex; gap: .5rem; align-items: center; margin-top: .7rem; }
  .err { color: var(--bad); font-size: .85rem; min-height: 1.2em; margin-top: .6rem; }
  .muted { color: var(--muted); }
  .small { font-size: .82rem; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem;
    width: 100%; min-height: 24rem; padding: .7rem; border-radius: 8px; tab-size: 2;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    line-height: 1.45; resize: vertical;
  }
  select { font: inherit; padding: .4rem .5rem; border-radius: 7px;
           border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  .toolbar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;
             margin-top: .7rem; }
  .toolbar .spacer { flex: 1; }
  .msg { margin-top: .7rem; font-size: .85rem; white-space: pre-wrap; }
  .msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); } .msg.warn { color: var(--warn); }
  .big { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat { text-align: center; padding: .8rem .5rem; }
  .stat .lbl { color: var(--muted); font-size: .75rem; text-transform: uppercase;
               letter-spacing: .05em; }
  textarea.pat { min-height: 5.5rem; }
  input[type=text], input[type=number] {
    font: inherit; padding: .45rem .6rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  input[type=text] { width: 100%; }
  input.num { width: 6rem; }
  .picker { display: flex; align-items: center; gap: .6rem; margin-bottom: .8rem; }
  .picker label { color: var(--muted); font-size: .82rem; }
  .picker select { flex: 1; max-width: 32rem; }
  .block { margin-bottom: .6rem; }
  .bhead { display: flex; align-items: center; gap: .5rem; margin-bottom: .55rem; }
  .bhead .spacer { flex: 1; }
  .blabel { font-size: .78rem; font-weight: 600; text-transform: uppercase;
            letter-spacing: .06em; color: var(--muted); }
  .bbody > * + * { margin-top: .55rem; }
  .bbody p { margin: 0; }
  button.x { border: none; background: none; color: var(--muted); font-size: 1.1rem;
             line-height: 1; padding: 0 .35rem; }
  button.x:hover { color: var(--bad); }
  .chips { display: flex; gap: .35rem; flex-wrap: wrap; }
  .chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px;
          border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
  .chip.on { background: var(--ok); border-color: var(--ok); color: #fff; }
  .chip:disabled { opacity: 1; }
  .trow { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .tlabel { font-size: .82rem; color: var(--muted); }
  .cbox { display: inline-flex; align-items: center; gap: .35rem; font-size: .85rem; }
  .cbox input { margin: 0; }
  .row.wrapx { flex-wrap: wrap; margin-top: 0; }
  .warn-text { color: var(--warn); }
  pre.cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem;
            background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
            padding: .5rem .6rem; margin: .4rem 0 0; overflow-x: auto; }
  button.linkish { border: none; background: none; color: var(--accent);
                   padding: .2rem 0; font-size: .85rem; }
  img.avatar { width: 72px; height: 72px; border-radius: 12px; object-fit: cover;
               border: 1px solid var(--line); background: var(--bg); }
  .grow { flex: 1; min-width: 12rem; }
  .flabel { display: block; font-size: .78rem; color: var(--muted);
            text-transform: uppercase; letter-spacing: .05em; margin-top: .3rem; }
  input[type=file] { font: inherit; font-size: .85rem; }
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

  // call() takes a path relative to the mount point; api() is the same thing for
  // the /api/* group. Both spell the base out rather than relying on the browser
  // to collapse a '..' — the page has to work at /admin and at /admin/ alike.
  function call(path, init) {
    init = init || {};
    var hasBody = init.body !== undefined;
    return fetch(base + path, {
      method: init.method || (hasBody ? 'POST' : 'GET'),
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin'
    });
  }
  function api(path, body) {
    return call('api/' + path, body === undefined ? {} : { body: body });
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
    statusPane = null; editorPane = null; editor = null;
    // The account name is checked for real now. It is still ONE account, and a
    // wrong name gives exactly the same answer as a wrong password, so it opens
    // no way to enumerate users — but it is no longer a decoration, and the
    // password manager gets an identity that means something.
    var user = h('input', { type: 'text', autocomplete: 'username',
                            'aria-label': 'Username', placeholder: 'Username' });
    var input = h('input', { type: 'password', autocomplete: 'current-password',
                             'aria-label': 'Admin password', placeholder: 'Password' });
    var totp = h('input', { type: 'text', autocomplete: 'one-time-code',
                            inputmode: 'numeric', maxlength: '6',
                            'aria-label': 'Authenticator code',
                            placeholder: '6-digit code from your authenticator' });
    var totpRow = h('div', {}, [totp]);
    totpRow.className = 'hidden';
    var err = h('div', { class: 'err', text: message || '' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'login card pad' }, [
      h('h1', { text: 'feedgen admin' }),
      h('p', { text: 'Config and status for the feed generator.' }),
      user, input, totpRow, h('div', { class: 'row' }, [btn]), err
    ]);

    // Ask whether a second factor is wanted, rather than showing a code field
    // that may be pointless or hiding one that is required.
    var wantsTotp = false;
    api('login-meta').then(function (r) { return r.json(); }).then(function (b) {
      wantsTotp = !!(b && b.totpRequired);
      if (wantsTotp) totpRow.className = '';
    }).catch(function () { /* a login attempt would say so anyway */ });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      var payload = { user: user.value, password: input.value };
      if (wantsTotp) payload.totp = totp.value;
      api('login', payload).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        btn.disabled = false;
        if (res.status === 200) { input.value = ''; totp.value = ''; load(); return; }
        // A rejected code leaves the password alone: retyping a long password
        // because the 30-second window turned over is miserable.
        if (res.body.needsTotp) {
          wantsTotp = true; totpRow.className = '';
          totp.value = ''; totp.focus();
        } else {
          input.select();
        }
        err.textContent = res.body.error || 'Sign-in failed';
      }).catch(function () {
        btn.disabled = false; err.textContent = 'Network error';
      });
    });
    app.appendChild(form);
    user.focus();
  }

  function renderStatus(s, root) {
    root.innerHTML = '';

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

    root.appendChild(h('header', {}, [
      h('h1', { text: 'feedgen admin' }),
      h('span', { class: 'mono muted', text: s.box.name }),
      boxPill,
      h('span', { class: 'spacer' }, []),
      refresh, logout
    ]));

    // ── service identity
    root.appendChild(h('h2', { text: 'Service' }));
    root.appendChild(h('div', { class: 'grid' }, [
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
      ])]),
      renderIdentity()
    ]));

    // ── ingest
    root.appendChild(h('h2', { text: 'Ingest' }));
    // sub_state is keyed by the endpoint STRING, so changing
    // FEEDGEN_SUBSCRIPTION_ENDPOINT starts a fresh row and freezes the old one
    // at the moment of the switch. Nothing reads it — the service loads the
    // cursor for its configured endpoint only — but showing it with a lag badge
    // reports a dead row as days behind, which reads as ingest being broken.
    // Only the configured endpoint gets a badge; the rest are labelled.
    var cursors = s.cursors.slice().sort(function (a, b) {
      var aa = a.service === s.service.subscriptionEndpoint ? 0 : 1;
      var bb = b.service === s.service.subscriptionEndpoint ? 0 : 1;
      return aa - bb;
    });
    var cursorCards = cursors.map(function (c) {
      var active = c.service === s.service.subscriptionEndpoint;
      var cls = c.lagSec == null ? '' : c.lagSec > 900 ? 'bad' : c.lagSec > 120 ? 'warn' : 'ok';
      var card = h('div', { class: 'card pad' + (active ? '' : ' inactive') }, [h('dl', {}, [
        kv('Endpoint', c.service.replace(/^wss?:\\/\\//, ''), 'mono small'),
        active
          ? kv('Behind by', ago(c.lagSec), 'pill ' + cls)
          : kv('Status', 'not in use', 'pill idle'),
        kv('Cursor at', c.at ? c.at.replace('T', ' ').replace('.000Z', 'Z') : '—', 'mono small')
      ])]);
      if (!active) {
        card.appendChild(h('p', { class: 'small muted note', text:
          'Left over from an earlier endpoint. The cursor is frozen at the ' +
          'moment of the switch and nothing reads it — deleting the row is not ' +
          'required.' }));
      }
      return card;
    });
    if (!cursorCards.length) {
      cursorCards = [h('div', { class: 'card pad muted', text: 'No cursor recorded yet.' })];
    }
    // Retention runs on a timer, not on write, so a feed sitting one post over
    // its limit is normal between sweeps. Saying when the last one ran turns
    // that from a suspected off-by-one into an expected wait.
    var g = s.gc || {};
    cursorCards.push(h('div', { class: 'card pad' }, [h('dl', {}, [
      kv('Retention sweep', g.lastAt ? ago(g.agoSec) + ' ago' : 'not yet this run'),
      kv('Next in', g.nextInSec == null ? '—' : ago(g.nextInSec)),
      kv('Failed feeds', g.failures == null ? '—' : String(g.failures),
         g.failures ? 'pill bad' : '')
    ])]));
    root.appendChild(h('div', { class: 'grid' }, cursorCards));
    root.appendChild(renderInstances(s));

    // ── feeds
    root.appendChild(h('h2', { text: 'Feeds' }));
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
    root.appendChild(h('div', { class: 'card wrap' }, [
      h('table', {}, [h('thead', {}, [head]), h('tbody', {}, body)])
    ]));

    // ── config file
    root.appendChild(h('h2', { text: 'Config' }));
    root.appendChild(h('div', { class: 'card pad' }, [h('dl', {}, [
      kv('File', s.filters.path, 'mono small'),
      kv('Digest', s.filters.sha256 || 'unreadable', 'mono small'),
      kv('Modified', s.filters.modified ? since(s.filters.modified) : '—'),
      kv('Size', s.filters.sizeBytes == null ? '—' : s.filters.sizeBytes + ' B')
    ])]));

    root.appendChild(h('footer', {
      text: 'Generated ' + s.generatedAt.replace('T', ' ').slice(0, 19) + 'Z'
    }));
  }

  // ── the config editor: one feed at a time, shown as blocks
  //
  // The shape follows SkyFeed's builder, because that is the mental model these
  // feeds were built with. Where this engine genuinely differs the block is
  // still shown but marked fixed, rather than offering a control that does
  // nothing: replies are always dropped, reposts are never indexed at all (they
  // are a different collection), and the order is by indexedAt descending.
  //
  // Block ORDER carries no meaning here either — includes are OR'd against each
  // other and so are excludes — so there is nothing to drag.
  function renderConfigEditor(s, root) {
    var full = null, digest = null, writable = false, key = null, draft = null;
    // A snapshot of the open feed as it was loaded or last saved. Anything
    // else means unsaved work, which freezes the status refresh.
    var pristine = '';
    function isDirty() { return !!draft && JSON.stringify(draft) !== pristine; }

    var feedSel = h('select', { 'aria-label': 'Feed to edit' });
    var picker = h('div', { class: 'picker' }, [
      h('label', { text: 'Editing feed', for: 'feedsel' }), feedSel
    ]);
    var blocks = h('div', {}, []);
    var msg = h('div', { class: 'msg' });
    var results = h('div', {}, []);

    var btnValidate = h('button', { text: 'Validate' });
    var btnMeasure = h('button', { text: 'Measure this edit' });
    var btnSave = h('button', { class: 'primary', text: 'Save' });
    var btnReload = h('button', { text: 'Reload' });
    var dirtyFlag = h('span', { class: 'small warn-text' });
    var toolbar = h('div', { class: 'toolbar' }, [
      btnValidate, btnMeasure, dirtyFlag,
      h('span', { class: 'spacer' }, []), btnReload, btnSave
    ]);
    function showDirty() {
      dirtyFlag.textContent = isDirty()
        ? 'unsaved changes — auto-refresh paused' : '';
    }

    root.appendChild(h('h2', { text: 'Filters' }));
    root.appendChild(picker);
    root.appendChild(blocks);
    root.appendChild(toolbar);
    root.appendChild(msg);
    root.appendChild(results);
    renderProbe(root);
    renderWhyNot(root);
    renderWizard(root);

    function say(t, cls) { msg.className = 'msg ' + (cls || ''); msg.textContent = t; }
    function busy(on) {
      [btnValidate, btnMeasure, btnSave, btnReload].forEach(function (b) { b.disabled = on; });
      if (!on) btnSave.disabled = !writable;
    }
    // The whole config, with only the edited feed replaced. Anything this
    // editor does not model — a comment key, another feed — is carried through
    // untouched rather than rewritten from what the UI happens to know.
    function assembled() {
      var out = JSON.parse(JSON.stringify(full));
      out.feeds[key] = draft;
      return out;
    }

    // ── block scaffolding
    function block(label, controls, opts) {
      opts = opts || {};
      var head = h('div', { class: 'bhead' }, [h('span', { class: 'blabel', text: label })]);
      if (opts.onRemove) {
        var x = h('button', { class: 'x', title: 'Remove this block', text: '×' });
        x.addEventListener('click', opts.onRemove);
        head.appendChild(h('span', { class: 'spacer' }, []));
        head.appendChild(x);
      } else if (opts.fixed) {
        head.appendChild(h('span', { class: 'spacer' }, []));
        head.appendChild(h('span', { class: 'pill idle', text: 'fixed' }));
      }
      var body = h('div', { class: 'bbody' }, controls);
      return h('div', { class: 'card pad block' + (opts.fixed ? ' inactive' : '') }, [head, body]);
    }

    function chip(text, on, onClick) {
      var b = h('button', { class: 'chip' + (on ? ' on' : ''), text: text });
      if (onClick) b.addEventListener('click', onClick); else b.disabled = true;
      return b;
    }

    function checkbox(label, checked, onChange) {
      var input = h('input', { type: 'checkbox' });
      input.checked = !!checked;
      input.addEventListener('change', function () { onChange(input.checked); });
      var lab = h('label', { class: 'cbox' }, [input, h('span', { text: label })]);
      return lab;
    }

    // ── regex blocks
    // Our targets are three cumulative settings, not free checkboxes: text,
    // text+alt, text+alt+link. "Link only" cannot be expressed, so Link implies
    // Alt and clearing Alt clears Link.
    function targetOf(p, kind) {
      return p.target || (kind === 'include' ? 'text|alt_text' : 'text|alt_text|link');
    }
    function patternBlock(p, kind, i) {
      var target = targetOf(p, kind);
      var alt = target.indexOf('alt_text') >= 0;
      var link = target.indexOf('link') >= 0;
      var sensitive = (p.flags !== undefined) && p.flags.indexOf('i') < 0;

      var area = h('textarea', { class: 'pat', spellcheck: 'false', 'aria-label': 'Pattern' });
      area.value = p.pattern || '';
      area.addEventListener('input', function () { p.pattern = area.value; });

      var comment = h('input', { type: 'text', placeholder: 'note to your future self (optional)' });
      comment.value = p.comment || '';
      comment.addEventListener('input', function () {
        if (comment.value) p.comment = comment.value; else delete p.comment;
      });

      function setTarget() {
        p.target = link ? 'text|alt_text|link' : alt ? 'text|alt_text' : 'text';
        redraw();
      }
      var chips = h('div', { class: 'chips' }, [
        chip('Post Text', true, null),
        chip('Image Alt Text', alt, function () {
          alt = !alt; if (!alt) link = false; setTarget();
        }),
        chip('Link', link, function () {
          link = !link; if (link) alt = true; setTarget();
        })
      ]);

      var flagsRow = h('div', { class: 'row wrapx' }, [
        checkbox('Case sensitive', sensitive, function (on) {
          // Preserve any other flag someone set by hand; only 'i' is ours.
          var base = (p.flags === undefined ? 'iu' : p.flags).replace(/i/g, '');
          var next = on ? base : 'i' + base;
          if (next === 'iu') delete p.flags; else p.flags = next;
        }),
        h('span', { class: 'small muted', text:
          kind === 'include'
            ? 'A post enters the feed if ANY include pattern matches.'
            : 'A post is dropped if ANY exclude pattern matches.' })
      ]);

      return block(
        (kind === 'include' ? 'RegEx — keep' : 'RegEx — remove') + ' #' + (i + 1),
        [area, h('div', { class: 'trow' }, [h('span', { class: 'tlabel', text: 'Target' }), chips]),
         flagsRow, comment],
        { onRemove: function () {
            var list = kind === 'include' ? draft.includePatterns : draft.excludePatterns;
            list.splice(list.indexOf(p), 1);
            redraw();
          } }
      );
    }

    function selectBlock(label, value, options, onChange, note) {
      var sel = h('select', {}, []);
      options.forEach(function (o) {
        var opt = h('option', { value: o[0], text: o[1] });
        if (o[0] === value) opt.setAttribute('selected', 'selected');
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () { onChange(sel.value); });
      var kids = [sel];
      if (note) kids.push(h('span', { class: 'small muted', text: note }));
      return block(label, [h('div', { class: 'row wrapx' }, kids)]);
    }

    function redraw() {
      blocks.innerHTML = '';
      if (!draft) return;
      blocks.appendChild(recordCard());

      // Input — the closest thing this engine has to SkyFeed's source block.
      var retType = (draft.retention && draft.retention.type) || 'hours';
      var retVal = (draft.retention && draft.retention.value) || 72;
      var unit = h('select', {}, []);
      [['hours', 'by age'], ['count', 'by count']].forEach(function (o) {
        var opt = h('option', { value: o[0], text: o[1] });
        if (o[0] === retType) opt.setAttribute('selected', 'selected');
        unit.appendChild(opt);
      });
      unit.addEventListener('change', function () {
        // The two units do not convert into each other — 500 posts is not 500
        // hours — so switching picks that unit's usual value rather than
        // carrying a number across that would mean something else.
        draft.retention = unit.value === 'hours'
          ? { type: 'hours', value: 72 }
          : { type: 'count', value: 500 };
        redraw();
      });

      var value;
      if (retType === 'hours') {
        var LABEL = { 3: '3 hours', 12: '12 hours', 24: '24 hours (1 day)',
                      72: '72 hours (3 days)', 168: '168 hours (7 days)' };
        var choices = [3, 12, 24, 72, 168];
        // Never quietly round a value that is already on disk: an unlisted one
        // gets its own option instead, so opening the page cannot change it.
        if (choices.indexOf(retVal) < 0) {
          choices.push(retVal);
          choices.sort(function (a, b) { return a - b; });
        }
        value = h('select', {}, []);
        choices.forEach(function (v) {
          var opt = h('option', { value: String(v),
            text: LABEL[v] || (v + ' hours (kept as set)') });
          if (v === retVal) opt.setAttribute('selected', 'selected');
          value.appendChild(opt);
        });
        value.value = String(retVal);
        value.addEventListener('change', function () {
          draft.retention = { type: 'hours', value: parseInt(value.value, 10) };
        });
      } else {
        value = h('input', { type: 'number', min: '1', class: 'num' });
        value.value = String(retVal);
        value.addEventListener('input', function () {
          var v = parseInt(value.value, 10);
          if (v > 0) draft.retention = { type: 'count', value: v };
        });
      }

      blocks.appendChild(block('Input', [
        h('div', { class: 'row wrapx' }, [
          h('span', { text: 'Entire network, continuously. Keep' }), unit, value,
          h('span', { class: 'small muted',
            text: retType === 'count' ? 'newest posts' : '' })
        ]),
        h('p', { class: 'small muted', text:
          'There is no time window on the source: this box reads the firehose ' +
          'without pause. Retention is what bounds the feed, and the hourly GC ' +
          'enforces it.' })
      ]));

      var label = h('input', { type: 'text', placeholder: 'label for logs' });
      label.value = draft.displayName || '';
      label.addEventListener('input', function () {
        if (label.value) draft.displayName = label.value; else delete draft.displayName;
      });
      blocks.appendChild(block('Internal label', [label, h('p', { class: 'small muted', text:
        'Only this page and the service log ever show it. The name readers see is ' +
        'in the card above, which publishes to your PDS.' })]));

      (draft.includePatterns || []).forEach(function (p, i) {
        blocks.appendChild(patternBlock(p, 'include', i));
      });

      if ((draft.includeDids || []).length) {
        var dids = h('textarea', { class: 'pat', spellcheck: 'false' });
        dids.value = draft.includeDids.join('\\n');
        dids.addEventListener('input', function () {
          draft.includeDids = dids.value.split(/\\s+/).filter(Boolean);
        });
        blocks.appendChild(block('Authors — keep only these DIDs', [dids,
          h('p', { class: 'small muted', text: 'One DID per line. With this set, ' +
            'nothing else can enter the feed.' })]));
      }

      (draft.excludePatterns || []).forEach(function (p, i) {
        blocks.appendChild(patternBlock(p, 'exclude', i));
      });

      blocks.appendChild(selectBlock('Remove if — item has labels',
        draft.selfLabeledPosts || 'exclude',
        [['allow', 'allow them'], ['exclude', 'remove them'], ['only', 'ONLY them']],
        function (v) { draft.selfLabeledPosts = v; },
        'Self-labelled (adult) posts.'));

      blocks.appendChild(selectBlock('Remove if — item is a GIF',
        draft.gifPosts || 'allow',
        [['allow', 'allow them'], ['exclude', 'remove them'], ['only', 'ONLY them']],
        function (v) { draft.gifPosts = v; },
        'Tenor links and bare .gif URLs.'));

      blocks.appendChild(selectBlock('Remove if — item is a quote post',
        draft.quotePosts || 'allow',
        [['allow', 'allow them'], ['exclude', 'remove them'], ['only', 'ONLY them']],
        function (v) { draft.quotePosts = v; }));

      var listUri = h('input', { type: 'text', placeholder: 'at://…/app.bsky.graph.list/…' });
      listUri.value = draft.excludeListUri || '';
      listUri.addEventListener('input', function () {
        if (listUri.value) draft.excludeListUri = listUri.value.trim();
        else delete draft.excludeListUri;
      });
      blocks.appendChild(block('Remove — list of users', [listUri,
        h('p', { class: 'small muted', text:
          'Read from the AppView and refreshed hourly, so a newly added account ' +
          'is not blocked immediately — and adding one never removes posts ' +
          'already stored.' })]));

      var pin = h('input', { type: 'text',
        placeholder: 'https://bsky.app/profile/…/post/… — or an at:// URI' });
      pin.value = draft.pinnedPost || '';
      var pinMsg = h('div', { class: 'small muted' });
      var pinBtn = h('button', { text: 'Resolve' });
      function applyPin(v) {
        if (v) draft.pinnedPost = v; else delete draft.pinnedPost;
      }
      pin.addEventListener('input', function () { applyPin(pin.value.trim()); });
      function resolvePin() {
        var v = pin.value.trim();
        if (!v) { pinMsg.className = 'small muted'; pinMsg.textContent = ''; return; }
        pinBtn.disabled = true;
        pinMsg.className = 'small muted'; pinMsg.textContent = 'Resolving…';
        call('resolve/post', { body: { input: v } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          pinBtn.disabled = false;
          if (res.status !== 200) {
            pinMsg.className = 'small warn-text'; pinMsg.textContent = res.body.error;
            return;
          }
          var post = res.body.post;
          pin.value = post.uri; applyPin(post.uri); showDirty();
          if (post.exists) {
            pinMsg.className = 'small muted';
            pinMsg.textContent = '@' + post.handle + ' — ' + post.text;
          } else {
            pinMsg.className = 'small warn-text';
            pinMsg.textContent =
              'That URI is well formed, but there is no such post right now. A ' +
              'pin pointing at a deleted post is dropped during hydration with ' +
              'nothing in the log — it simply never appears.';
          }
        }).catch(function (e) {
          pinBtn.disabled = false;
          pinMsg.className = 'small warn-text';
          pinMsg.textContent = 'Network error: ' + e.message;
        });
      }
      pinBtn.addEventListener('click', resolvePin);
      // Blur after pasting a link resolves it without being asked; an at:// URI
      // that is already correct is left alone.
      pin.addEventListener('change', function () {
        if (/^https?:/i.test(pin.value.trim())) resolvePin();
      });
      blocks.appendChild(block('Pinned post', [
        h('div', { class: 'row wrapx' }, [pin, pinBtn]), pinMsg,
        h('p', { class: 'small muted', text:
          'Paste the link straight from the app — the handle in it is resolved to ' +
          'a DID here, because the config stores at:// URIs. Served first on page ' +
          '1 with the Pinned badge. Whether it survives un-pinning depends on ' +
          'whether it matches this feed on its own.' })]));

      blocks.appendChild(block('Remove if — item is a reply',
        [h('p', { class: 'small muted', text:
          'Always on. Every one of these feeds dropped replies under SkyFeed and ' +
          'the ingest keeps doing it — there is no setting.' })], { fixed: true }));
      blocks.appendChild(block('Remove if — item is a repost',
        [h('p', { class: 'small muted', text:
          'Reposts are a different collection and are never indexed, so there is ' +
          'nothing to remove.' })], { fixed: true }));
      blocks.appendChild(block('Sort by',
        [h('p', { class: 'small muted', text:
          'indexedAt, descending — stamped from the Jetstream event time, so a ' +
          'replayed post lands in its true position rather than on top.' })],
        { fixed: true }));

      var addInc = h('button', { text: '+ RegEx — keep' });
      addInc.addEventListener('click', function () {
        draft.includePatterns = draft.includePatterns || [];
        draft.includePatterns.push({ pattern: '' });
        redraw();
      });
      var addExc = h('button', { text: '+ RegEx — remove' });
      addExc.addEventListener('click', function () {
        draft.excludePatterns = draft.excludePatterns || [];
        draft.excludePatterns.push({ pattern: '' });
        redraw();
      });
      blocks.appendChild(h('div', { class: 'toolbar' }, [addInc, addExc,
        h('span', { class: 'small muted', text:
          'Order does not matter: includes are OR-ed together, and so are excludes.' })]));
      showDirty();
    }

    // ── the feed RECORD: name, description, avatar — what readers see.
    //
    // These are not in filters.json at all; they live in the feed's record on
    // the PDS. Keeping them in a separate card with its own button is the
    // point: pressing Save below must never look like it might publish them,
    // and publishing must never look like it might change a filter.
    var records = {};      // rkey -> the live record, once fetched
    var pendingAvatar = null;  // {base64, dataUrl, name} chosen but not published

    function credsRow(id) {
      var handle = h('input', { type: 'text', autocomplete: 'username',
                                placeholder: 'your handle, e.g. you.bsky.social' });
      var pass = h('input', { type: 'password', autocomplete: 'current-password',
                              placeholder: 'app password' });
      var row = h('div', {}, [
        h('div', { class: 'row wrapx' }, [handle, pass]),
        h('p', { class: 'small muted', text:
          'Used for this one write and then forgotten — nothing is stored on the ' +
          'box. It must be an APP PASSWORD (Settings → Privacy and security → ' +
          'App passwords), not your account password: app passwords skip the ' +
          'emailed code and can be revoked on their own.' })
      ]);
      return { el: row, handle: handle, pass: pass };
    }

    function recordCard() {
      var card = h('div', { class: 'card pad block' }, []);
      var head = h('div', { class: 'bhead' }, [
        h('span', { class: 'blabel', text: 'Feed record — what readers see' })
      ]);
      var bodyEl = h('div', { class: 'bbody' }, [
        h('p', { class: 'small muted', text: 'Loading the published record…' })
      ]);
      card.appendChild(head);
      card.appendChild(bodyEl);

      var rec = records[key];
      if (rec) fill(bodyEl, rec);
      else {
        call('feed/' + encodeURIComponent(key) + '/record').then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          bodyEl.innerHTML = '';
          if (res.status !== 200) {
            bodyEl.appendChild(h('p', { class: 'small warn-text', text:
              'No published record for this rkey: ' + res.body.error }));
            return;
          }
          records[key] = res.body.record;
          fill(bodyEl, res.body.record);
        }).catch(function (e) {
          bodyEl.innerHTML = '';
          bodyEl.appendChild(h('p', { class: 'small warn-text',
            text: 'Could not read the record: ' + e.message }));
        });
      }
      return card;

      function fill(el, rec) {
        el.innerHTML = '';
        var name = h('input', { type: 'text', placeholder: 'display name' });
        name.value = rec.displayName || '';
        var desc = h('textarea', { class: 'pat', spellcheck: 'false',
                                   placeholder: 'description shown on the feed page' });
        desc.value = rec.description || '';

        var img = h('img', { class: 'avatar', alt: 'current avatar' });
        img.setAttribute('src', base + 'feed/' + encodeURIComponent(key) + '/avatar');
        var file = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
        var fileMsg = h('div', { class: 'small muted' });
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          if (!f) { pendingAvatar = null; fileMsg.textContent = ''; return; }
          var reader = new FileReader();
          reader.onload = function () {
            pendingAvatar = { base64: String(reader.result), name: f.name };
            img.setAttribute('src', String(reader.result));
            fileMsg.className = 'small muted';
            fileMsg.textContent = f.name + ' — ' + Math.round(f.size / 1024) +
              ' KB, not published yet' +
              (f.size > 1000000 ? ' — OVER the 1 MB the lexicon allows' : '');
          };
          reader.readAsDataURL(f);
        });

        var creds = credsRow();
        var btn = h('button', { class: 'primary', text: 'Publish to Bluesky' });
        var out = h('div', { class: 'msg' });
        btn.disabled = !writable;
        btn.addEventListener('click', function () {
          var payload = { handle: creds.handle.value, password: creds.pass.value };
          if (name.value !== (rec.displayName || '')) payload.displayName = name.value;
          if (desc.value !== (rec.description || '')) payload.description = desc.value;
          if (pendingAvatar) payload.avatarBase64 = pendingAvatar.base64;
          if (payload.displayName === undefined && payload.description === undefined &&
              !payload.avatarBase64) {
            out.className = 'msg warn'; out.textContent = 'Nothing changed here yet.';
            return;
          }
          btn.disabled = true;
          out.className = 'msg'; out.textContent = 'Publishing…';
          call('feed/' + encodeURIComponent(key) + '/record', { body: payload })
            .then(function (r) {
              return r.json().then(function (b) { return { status: r.status, body: b }; });
            }).then(function (res) {
              btn.disabled = false;
              // The password is dropped the moment it has been used, here too.
              creds.pass.value = '';
              if (res.status !== 200) {
                out.className = 'msg bad'; out.textContent = res.body.error; return;
              }
              records[key] = { uri: res.body.uri, cid: res.body.cid,
                displayName: name.value, description: desc.value,
                avatarCid: rec.avatarCid };
              pendingAvatar = null;
              out.className = 'msg ok';
              out.textContent = 'Published: ' + res.body.changed.join(', ') +
                '. Bluesky may take a minute to show it.';
            }).catch(function (e) {
              btn.disabled = false;
              out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
            });
        });

        el.appendChild(h('div', { class: 'row wrapx' }, [img,
          h('div', { class: 'grow' }, [file, fileMsg])]));
        el.appendChild(h('label', { class: 'flabel', text: 'Display name' }));
        el.appendChild(name);
        el.appendChild(h('label', { class: 'flabel', text: 'Description' }));
        el.appendChild(desc);
        el.appendChild(creds.el);
        el.appendChild(h('div', { class: 'toolbar' }, [btn]));
        el.appendChild(out);
        el.appendChild(h('p', { class: 'small muted', text:
          'This card writes to your PDS the moment you press Publish — it is not ' +
          'part of Save below, which only touches filters.json. The AT-URI never ' +
          'changes, so likes and subscribers are untouched.' }));
      }
    }


    // ── probe: one regex over the stored posts, without building a whole
    // candidate config first. This is the measurement the filter policy is
    // written from, made cheap enough to actually do before every edit.
    function renderProbe(root) {
      // Four backslashes: the template literal turns them into two, and only
      // then does JS read \\b as an escaped backslash. Written with two, the
      // page ends up with \b — the BACKSPACE character — and the field shows
      // two little boxes instead of a word boundary.
      var pat = h('input', { type: 'text', placeholder: '\\\\b(?:term|other term)\\\\b' });
      var target = h('select', {}, []);
      [['text|alt_text|link', 'text + alt text + links'],
       ['text|alt_text', 'text + alt text'],
       ['text', 'post text only']].forEach(function (o) {
        target.appendChild(h('option', { value: o[0], text: o[1] }));
      });
      target.value = 'text|alt_text|link';
      var sensitive = false;
      var cs = checkbox('Case sensitive', false, function (on) { sensitive = on; });
      var btn = h('button', { text: 'Count matches' });
      var out = h('div', { class: 'msg' });
      var body = h('div', {}, []);

      function run() {
        if (!pat.value.trim()) return;
        btn.disabled = true; body.innerHTML = '';
        out.className = 'msg';
        out.textContent = 'Counting — the first run for a feed fetches its posts…';
        call('lab/probe', { body: { feed: key, pattern: pat.value,
          flags: sensitive ? 'u' : 'iu', target: target.value } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          btn.disabled = false;
          if (res.status !== 200) {
            out.className = 'msg bad'; out.textContent = res.body.error; return;
          }
          out.textContent = ''; show(res.body.result);
        }).catch(function (e) {
          btn.disabled = false;
          out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
        });
      }
      btn.addEventListener('click', run);
      pat.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });

      function show(r) {
        body.innerHTML = '';
        body.appendChild(h('div', { class: 'grid' }, [
          h('div', { class: 'card stat' }, [
            h('div', { class: 'big', text: String(r.hits) }),
            h('div', { class: 'lbl', text: 'posts touched' })]),
          h('div', { class: 'card stat' }, [
            h('div', { class: 'big', text: r.hitsPct + '%' }),
            h('div', { class: 'lbl', text: 'of ' + r.stored + ' stored' })])
        ]));
        if (r.hits && r.wouldExceedAutoPurgeCap) {
          body.appendChild(h('p', { class: 'msg warn', text:
            'As an exclude this would be over the auto-purge cap (25 posts or 5%), ' +
            'so the sweep would be withheld rather than applied.' }));
        }
        body.appendChild(h('p', { class: 'small muted', text: r.note }));
        if (r.samples.length) {
          var rows = r.samples.map(function (x) {
            return h('tr', {}, [
              h('td', { class: 'small', text: '@' + x.handle }),
              h('td', { class: 'mono small', text: x.matched }),
              h('td', { class: 'small', text: x.text || '(no text)' })
            ]);
          });
          body.appendChild(h('div', { class: 'card wrap' }, [
            h('table', {}, [
              h('thead', {}, [h('tr', {}, [
                h('th', { text: 'Author' }), h('th', { text: 'Matched' }),
                h('th', { text: 'Text' })])]),
              h('tbody', {}, rows)])]));
          if (r.hits > r.samples.length) {
            body.appendChild(h('p', { class: 'small muted',
              text: 'Showing the first ' + r.samples.length + ' of ' + r.hits + '.' }));
          }
        } else {
          body.appendChild(h('p', { class: 'small muted', text:
            'Nothing matched. On the exclude side that means zero collateral — ' +
            'and also that nothing has needed it yet.' }));
        }
      }

      root.appendChild(h('h2', { text: 'Try a pattern' }));
      root.appendChild(h('div', { class: 'card pad' }, [
        h('div', { class: 'row wrapx' }, [pat, target, cs, btn]),
        h('p', { class: 'small muted', text:
          'Counts how many stored posts in THIS feed the expression touches, ' +
          'and shows what it matched in each. As an exclude, that count is exactly ' +
          'what would leave. An include cannot be measured this way — posts it ' +
          'would newly bring in were never stored here.' }),
        out, body
      ]));
    }

    // ── whyNot: one post, answered from the point of view of the open feed.
    var lastWhy = null;
    var redrawWhy = function () {};
    // ── whyNot
    function renderWhyNot(root) {
      var input = h('input', { type: 'text',
        placeholder: 'https://bsky.app/profile/…/post/… — or an at:// URI' });
      var btn = h('button', { class: 'primary', text: 'Explain' });
      var out = h('div', { class: 'msg' });
      var body = h('div', {}, []);

      function ask() {
        var v = input.value.trim();
        if (!v) return;
        btn.disabled = true; body.innerHTML = '';
        out.className = 'msg'; out.textContent = 'Looking it up…';
        call('whynot', { body: { input: v } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          btn.disabled = false;
          if (res.status !== 200) {
            out.className = 'msg bad'; out.textContent = res.body.error; return;
          }
          out.textContent = ''; show(res.body.result);
        }).catch(function (e) {
          btn.disabled = false;
          out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
        });
      }
      btn.addEventListener('click', ask);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ask(); });

      function show(r) {
        body.innerHTML = '';
        lastWhy = r;
        var facts = h('div', { class: 'card pad' }, [h('dl', {}, [
          kv('Author', '@' + r.handle),
          kv('Posted', r.createdAt ? r.createdAt.replace('T', ' ').slice(0, 19) + 'Z' : '—'),
          kv('Embed', r.embed),
          kv('Reply', r.isReply ? 'yes — replies are always dropped' : 'no')
        ])]);
        body.appendChild(facts);
        body.appendChild(h('p', { class: 'small', text: r.text || '(no text)' }));
        if (r.alt) {
          body.appendChild(h('p', { class: 'small muted', text: 'alt text: ' + r.alt }));
        }

        function reasonOf(f) {
          return f.reason || (f.includeMatch
            ? 'matched "' + f.includeMatch + '" on ' + f.includeTarget
            : 'matches this feed');
        }
        function disagreement(f) {
          if (!f.disagrees) return null;
          return f.stored
            ? 'But it IS stored — the config changed after this post was seen. ' +
              'auto-purge sweeps that within 5 minutes of a filter edit.'
            : 'But it is NOT stored — most often retention pruned it, or it ' +
              'arrived while the config was different.';
        }

        // The feed being edited gets the whole answer. The others are a
        // footnote: for feeds as unrelated as these, three lines of "no
        // includePattern matched" every time is noise, and noise teaches you
        // to stop reading the table.
        var mine = null, others = [];
        r.feeds.forEach(function (f) { if (f.key === key) mine = f; else others.push(f); });

        if (mine) {
          var head = h('div', { class: 'row wrapx' }, [
            h('span', { class: 'pill ' + (mine.wouldIndex ? 'ok' : 'bad'),
                        text: mine.wouldIndex ? 'matches' : 'dropped' }),
            h('span', { class: 'small', text: (mine.displayName || mine.key) }),
            h('span', { class: 'small muted',
                        text: mine.stored ? 'in the database' : 'not in the database' })
          ]);
          var kids = [head, h('p', { class: 'small', text: reasonOf(mine) })];
          var note = disagreement(mine);
          if (note) kids.push(h('p', { class: 'small warn-text', text: note }));
          body.appendChild(h('div', { class: 'card pad' }, kids));
        }

        if (!others.length) return;
        // Anything worth interrupting for: it landed elsewhere, or a feed's
        // stored state contradicts its own filter.
        var notable = others.filter(function (f) {
          return f.wouldIndex || f.stored || f.disagrees;
        });
        var open = notable.length > 0;
        var table = h('div', {}, []);
        var toggle = h('button', { class: 'linkish' });

        function draw() {
          table.innerHTML = '';
          toggle.textContent = (open ? '− ' : '+ ') + 'other feeds (' + others.length + ')' +
            (notable.length
              ? ' — ' + notable.length + ' with something to show'
              : ' — none matched');
          if (!open) return;
          var rows = others.map(function (f) {
            var v = h('td', {}, []);
            v.appendChild(h('span', { class: 'pill ' + (f.wouldIndex ? 'ok' : 'idle'),
                                      text: f.wouldIndex ? 'matches' : 'dropped' }));
            var why = h('td', { class: 'small' }, []);
            why.appendChild(document.createTextNode(reasonOf(f)));
            var n = disagreement(f);
            if (n) why.appendChild(h('div', { class: 'small warn-text', text: n }));
            return h('tr', {}, [
              h('td', { class: 'mono small', text: f.key }),
              h('td', { class: 'small', text: f.displayName || '—' }),
              v,
              h('td', { class: 'small', text: f.stored ? 'yes' : 'no' }),
              why
            ]);
          });
          table.appendChild(h('div', { class: 'card wrap' }, [
            h('table', {}, [
              h('thead', {}, [h('tr', {}, [
                h('th', { text: 'rkey' }), h('th', { text: 'Feed' }),
                h('th', { text: 'Verdict' }), h('th', { text: 'In DB' }),
                h('th', { text: 'Why' })])]),
              h('tbody', {}, rows)])]));
        }
        toggle.addEventListener('click', function () { open = !open; draw(); });
        body.appendChild(h('div', { class: 'toolbar' }, [toggle]));
        body.appendChild(table);
        draw();
      }

      // Switching the feed re-answers the same post from that feed's side.
      redrawWhy = function () { if (lastWhy) show(lastWhy); };

      root.appendChild(h('h2', { text: 'Why is this post (not) in a feed?' }));
      root.appendChild(h('div', { class: 'card pad' }, [
        h('div', { class: 'row wrapx' }, [input, btn]),
        h('p', { class: 'small muted', text:
          'Replays the live filter over every feed at once. The verdict comes ' +
          'from the same code the ingest runs, so it cannot disagree with it — ' +
          'and the moderation list and the database are checked on top, since ' +
          '"matches" and "is actually in the feed" are different questions.' }),
        out, body
      ]));
    }

    // ── the new-feed wizard
    //
    // Two writes behind one button: a record published to the PDS, and a feed
    // added to filters.json. The normal Save refuses to change the set of feeds
    // on purpose, because the routing table is built at startup — so creation
    // is its own deliberate path, and it ends by saying a restart is still
    // needed rather than pretending the feed is live.
    function renderWizard(root) {
      var open = false;
      var toggle = h('button', { text: '+ New feed' });
      var panel = h('div', {}, []);
      root.appendChild(h('h2', { text: 'Create a feed' }));
      root.appendChild(h('div', { class: 'toolbar' }, [toggle]));
      root.appendChild(panel);

      toggle.addEventListener('click', function () {
        open = !open;
        panel.innerHTML = '';
        toggle.textContent = open ? '− New feed' : '+ New feed';
        if (open) build();
      });

      function build() {
        var rkey = h('input', { type: 'text', placeholder: 'record key, e.g. myfeed' });
        var name = h('input', { type: 'text', placeholder: 'display name (max 24 characters)' });
        var desc = h('textarea', { class: 'pat', spellcheck: 'false',
                                   placeholder: 'description (optional)' });
        var pattern = h('textarea', { class: 'pat', spellcheck: 'false',
                                      placeholder: '\\\\b(?:topic|another topic)\\\\b' });
        var dids = h('input', { type: 'text',
                                placeholder: 'or author DIDs, comma separated (optional)' });
        var file = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
        var fileMsg = h('div', { class: 'small muted' });
        var avatar = null;
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          if (!f) { avatar = null; fileMsg.textContent = ''; return; }
          var reader = new FileReader();
          reader.onload = function () {
            avatar = String(reader.result);
            fileMsg.textContent = f.name + ' — ' + Math.round(f.size / 1024) + ' KB';
          };
          reader.readAsDataURL(f);
        });

        var retention = h('select', {}, []);
        [[3, '3 hours'], [12, '12 hours'], [24, '24 hours (1 day)'],
         [72, '72 hours (3 days)'], [168, '168 hours (7 days)']].forEach(function (o) {
          var opt = h('option', { value: String(o[0]), text: o[1] });
          if (o[0] === 72) opt.setAttribute('selected', 'selected');
          retention.appendChild(opt);
        });
        retention.value = '72';

        var creds = credsRow();
        var btn = h('button', { class: 'primary', text: 'Publish and add' });
        var out = h('div', { class: 'msg' });
        btn.disabled = !writable;

        btn.addEventListener('click', function () {
          var feed = { displayName: name.value, retention:
            { type: 'hours', value: parseInt(retention.value, 10) } };
          if (pattern.value.trim()) {
            feed.includePatterns = [{ pattern: pattern.value.trim() }];
          }
          if (dids.value.trim()) {
            feed.includeDids = dids.value.split(/[\\s,]+/).filter(Boolean);
          }
          if (!feed.includePatterns && !feed.includeDids) {
            out.className = 'msg bad';
            out.textContent = 'A feed needs at least one pattern or one author DID — ' +
              'without either it would match the entire firehose.';
            return;
          }
          if (!confirm('Publish a new feed record at "' + rkey.value + '" and add it ' +
                       'to the config?')) return;
          btn.disabled = true;
          out.className = 'msg'; out.textContent = 'Publishing…';
          call('feeds', { body: {
            handle: creds.handle.value, password: creds.pass.value,
            rkey: rkey.value.trim(), displayName: name.value,
            description: desc.value || undefined,
            avatarBase64: avatar || undefined,
            feed: feed, expectedDigest: digest,
          } }).then(function (r) {
            return r.json().then(function (b) { return { status: r.status, body: b }; });
          }).then(function (res) {
            btn.disabled = false;
            creds.pass.value = '';
            if (res.status !== 200) {
              out.className = 'msg bad';
              out.textContent = res.body.error + (res.body.published
                ? '\\n\\nThe RECORD was published at ' + res.body.published +
                  ' but the config was not written. Fix the problem and add the ' +
                  'feed by hand, or delete that record — it has no subscribers yet.'
                : '');
              return;
            }
            digest = res.body.digest;
            out.className = 'msg ok';
            out.textContent = 'Created ' + res.body.rkey + '.\\n' + res.body.note;
          }).catch(function (e) {
            btn.disabled = false;
            out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
          });
        });

        var card = h('div', { class: 'card pad' }, [
          h('label', { class: 'flabel', text: 'Record key (rkey)' }), rkey,
          h('p', { class: 'small muted', text:
            'This is the feed\\'s permanent identity: it appears in its AT-URI and ' +
            'must equal the key in filters.json. Letters, digits and . _ ~ - only. ' +
            'It cannot be changed later without losing the feed\\'s likes.' }),
          h('label', { class: 'flabel', text: 'Display name' }), name,
          h('label', { class: 'flabel', text: 'Description' }), desc,
          h('label', { class: 'flabel', text: 'Avatar' }), file, fileMsg,
          h('label', { class: 'flabel', text: 'Keep posts' }), retention,
          h('label', { class: 'flabel', text: 'Include pattern' }), pattern,
          h('label', { class: 'flabel', text: 'Author DIDs' }), dids,
          h('p', { class: 'small muted', text:
            'One of the two is required. A feed with neither would match every ' +
            'post on the network, and the service refuses to load such a config.' }),
          creds.el,
          h('div', { class: 'toolbar' }, [btn]), out,
          h('p', { class: 'small muted', text:
            'After this succeeds the feed is published and configured but NOT yet ' +
            'served: the routing table is built at startup, so the service needs a ' +
            'restart before it answers.' })
        ]);
        panel.appendChild(card);
      }
    }

    function selectFeed(k) {
      key = k;
      draft = JSON.parse(JSON.stringify(full.feeds[k] || {}));
      pristine = JSON.stringify(draft);
      results.innerHTML = '';
      say('');
      redraw();
      showDirty();
      redrawWhy();
    }

    feedSel.addEventListener('change', function () {
      // Switching feeds throws the draft away, so say so rather than doing it.
      if (isDirty() && !confirm('Discard unsaved changes to ' + key + '?')) {
        feedSel.value = key;
        return;
      }
      selectFeed(feedSel.value);
    });

    // Delegated, so every field added later is covered without wiring each one.
    root.addEventListener('input', showDirty);
    root.addEventListener('change', showDirty);

    function load() {
      busy(true); say('Loading…');
      call('filters').then(function (r) { return r.json(); }).then(function (b) {
        busy(false);
        if (!b.ok) { say(b.error || 'Could not load the config', 'bad'); return; }
        full = b.filters; digest = b.digest; writable = b.writable;
        btnSave.disabled = !writable;
        feedSel.innerHTML = '';
        Object.keys(full.feeds || {}).forEach(function (k) {
          var f = (s.feeds || []).filter(function (x) { return x.key === k; })[0];
          feedSel.appendChild(h('option', { value: k,
            text: (full.feeds[k].displayName || k) + ' — ' + k + (f ? ' — ' + f.rows + ' posts' : '') }));
        });
        selectFeed(feedSel.value || Object.keys(full.feeds || {})[0]);
        say('Loaded, digest ' + digest + (writable ? '' : ' — this box is read-only'),
            writable ? '' : 'warn');
      }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    }

    btnReload.addEventListener('click', function () {
      if (isDirty() && !confirm('Discard unsaved changes to ' + key + '?')) return;
      load();
    });

    btnValidate.addEventListener('click', function () {
      busy(true); say('Validating…');
      call('filters/validate', { body: assembled() }).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        busy(false);
        if (res.status !== 200) { say(res.body.error, 'bad'); return; }
        var me = res.body.feeds.filter(function (f) { return f.key === key; })[0] || {};
        say('Valid — ' + me.includePatterns + ' keep / ' + me.excludePatterns +
            ' remove, ' + me.includeDids + ' author DID(s).', 'ok');
      }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    });

    btnMeasure.addEventListener('click', function () {
      busy(true); results.innerHTML = '';
      say('Measuring against stored posts — the first run for a feed fetches them ' +
          'from the AppView and can take a while…');
      call('lab/measure', { body: { feed: key, filters: assembled() } }).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        busy(false);
        if (res.status !== 200) { say(res.body.error, 'bad'); return; }
        say(''); renderLab(res.body.result);
      }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    });

    btnSave.addEventListener('click', function () {
      if (!confirm('Save ' + key + '? It goes live within ~10 seconds, and ' +
                   'auto-purge will replay it over stored posts within 5 minutes.')) return;
      busy(true); say('Saving…');
      call('filters', { method: 'PUT', body: { filters: assembled(), expectedDigest: digest } })
        .then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          busy(false);
          if (res.status !== 200) { say(res.body.error, 'bad'); return; }
          digest = res.body.digest;
          full.feeds[key] = JSON.parse(JSON.stringify(draft));
          pristine = JSON.stringify(draft);
          showDirty();
          say('Saved. New digest ' + digest + '\\n' + res.body.note, 'ok');
        }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    });

    function renderLab(r) {
      results.innerHTML = '';
      results.appendChild(h('div', { class: 'grid' }, [
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: String(r.removed) }),
          h('div', { class: 'lbl', text: 'posts would be removed' })]),
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: r.removedPct + '%' }),
          h('div', { class: 'lbl', text: 'of ' + r.stored + ' stored' })]),
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: String(r.keptAfter) }),
          h('div', { class: 'lbl', text: 'would remain (now ' + r.keptNow + ')' })])
      ]));
      if (r.wouldExceedAutoPurgeCap) {
        results.appendChild(h('p', { class: 'msg bad', text:
          'This is over the auto-purge safety cap (25 posts or 5%). The cleanup ' +
          'would REFUSE to apply it and log the refusal instead, so the posts ' +
          'would sit in the feed until someone looks. On a small feed even one ' +
          'post can cross the 5% line — check the count, not just the colour.' }));
      }
      if (r.unretrievable) {
        results.appendChild(h('p', { class: 'msg warn', text:
          r.unretrievable + ' stored row(s) could not be fetched from the AppView ' +
          '(deleted upstream) and were not measured.' }));
      }
      results.appendChild(h('p', { class: 'small muted',
        text: r.note + ' Corpus fetched ' + since(r.cachedAt) + '.' }));
      if (r.samples.length) {
        var rows = r.samples.map(function (x) {
          return h('tr', {}, [
            h('td', { class: 'small', text: '@' + x.handle }),
            h('td', { class: 'small', text: x.text || '(no text)' }),
            h('td', { class: 'small muted', text: x.reason })
          ]);
        });
        results.appendChild(h('div', { class: 'card wrap' }, [
          h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Author' }), h('th', { text: 'Text' }),
              h('th', { text: 'Why it would go' })])]),
            h('tbody', {}, rows)])]));
        if (r.removed > r.samples.length) {
          results.appendChild(h('p', { class: 'small muted',
            text: 'Showing the first ' + r.samples.length + ' of ' + r.removed + '.' }));
        }
      }
    }

    load();
    return { isDirty: isDirty };
  }


  // Every public Jetstream instance, with its measured lag and the exact way to
  // move to one. The lag matters because an instance can fall HOURS behind while
  // still stamping fresh event times — the cursor looks perfect and the feed
  // quietly serves stale posts. That has happened here once already.
  function renderInstances(s) {
    var box = h('div', {}, []);
    var active = s.service.subscriptionEndpoint;

    var btn = h('button', { text: jetstream.busy ? 'Measuring…' : 'Measure lag' });
    btn.disabled = jetstream.busy;
    btn.addEventListener('click', function () {
      jetstream.busy = true; jetstream.chosen = null;
      btn.disabled = true; btn.textContent = 'Measuring…';
      call('jetstream/probe', { body: {} }).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        jetstream.busy = false;
        jetstream.readings = res.status === 200 ? res.body.readings : null;
        if (res.status !== 200) jetstream.error = res.body.error;
        load();
      }).catch(function (e) {
        jetstream.busy = false; jetstream.error = e.message; load();
      });
    });

    var rows = [];
    var list = jetstream.readings ||
      [{ endpoint: active, medianAgeSec: null, samples: 0, error: null }];
    list.forEach(function (r) {
      var isActive = r.endpoint === active;
      var cls = r.medianAgeSec == null ? 'idle'
        : r.medianAgeSec > 600 ? 'bad' : r.medianAgeSec > 60 ? 'warn' : 'ok';
      var lag = h('td', {}, []);
      lag.appendChild(h('span', { class: 'pill ' + cls, text:
        r.error ? r.error : r.medianAgeSec == null ? 'not measured' : ago(r.medianAgeSec) }));

      var action = h('td', {}, []);
      if (isActive) {
        action.appendChild(h('span', { class: 'pill ok', text: 'in use' }));
      } else if (!r.error) {
        var use = h('button', { class: 'chip', text: 'use this' });
        use.addEventListener('click', function () {
          jetstream.chosen = r.endpoint;
          load();
        });
        action.appendChild(use);
      }

      rows.push(h('tr', {}, [
        h('td', { class: 'mono small', text: r.endpoint.replace(/^wss:\\/\\//, '') }),
        lag,
        h('td', { class: 'small muted', text: r.samples ? r.samples + ' posts' : '—' }),
        action
      ]));
    });

    box.appendChild(h('div', { class: 'card wrap' }, [
      h('table', {}, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Jetstream instance' }),
          h('th', { text: 'Posts arriving this far behind' }),
          h('th', { text: 'Sampled' }), h('th', { text: '' })])]),
        h('tbody', {}, rows)])]));

    var tools = h('div', { class: 'toolbar' }, [btn]);
    if (jetstream.error) {
      tools.appendChild(h('span', { class: 'small warn-text', text: jetstream.error }));
    } else if (!jetstream.readings) {
      tools.appendChild(h('span', { class: 'small muted', text:
        'Measures the median age of posts arriving from each instance — the only ' +
        'thing that reveals a lagging one, since its event times look fresh.' }));
    }
    box.appendChild(tools);

    // Switching is two manual steps and this says so. The endpoint is read once
    // at startup, .env is not mounted into the container, and a container does
    // not restart itself — a button that claimed to switch would be lying.
    if (jetstream.chosen) {
      box.appendChild(h('div', { class: 'card pad' }, [
        h('p', { class: 'small', text: 'To move ingest to ' +
          jetstream.chosen.replace(/^wss:\\/\\//, '') + ', on this box:' }),
        h('pre', { class: 'cmd', text:
          'FEEDGEN_SUBSCRIPTION_ENDPOINT="' + jetstream.chosen + '"' }),
        h('pre', { class: 'cmd', text: 'docker compose up -d feedgen' }),
        h('p', { class: 'small muted', text:
          'The first line replaces the existing one in .env. This page cannot do ' +
          'either step: the endpoint is read once at startup, .env is not mounted ' +
          'into the container, and the container cannot restart itself.' }),
        h('p', { class: 'small muted', text:
          'sub_state is keyed by the endpoint STRING, so the new one starts with ' +
          'no cursor and ingest resumes live — you lose only the restart itself. ' +
          'The old row stays behind, frozen, and shows up above as not in use.' })
      ]));
    }
    return box;
  }

  // Does the identity Bluesky resolves still match this box? Read-only, and on
  // a button rather than in the refresh, so a slow plc.directory can never
  // stall the page.
  function renderIdentity() {
    var box = h('div', { class: 'card pad' }, []);
    var btn = h('button', { text: identity.busy ? 'Checking…' : 'Check identity' });
    btn.disabled = identity.busy;
    btn.addEventListener('click', function () {
      identity.busy = true; identity.error = null; btn.disabled = true;
      call('identity').then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        identity.busy = false;
        if (res.status === 200) identity.result = res.body.identity;
        else identity.error = res.body.error;
        load();
      }).catch(function (e) { identity.busy = false; identity.error = e.message; load(); });
    });

    box.appendChild(h('div', { class: 'toolbar' }, [btn]));
    if (identity.error) {
      box.appendChild(h('p', { class: 'small warn-text', text: identity.error }));
    }
    var r = identity.result;
    if (r) {
      box.appendChild(h('dl', {}, [
        kv('Handle', r.handle || '—'),
        kv('Bluesky calls', r.feedEndpoint || 'nothing — no #bsky_fg entry', 'mono small'),
        kv('This box expects', r.expectedEndpoint, 'mono small'),
        kv('Agreement', r.matches ? 'match' : 'MISMATCH',
           'pill ' + (r.matches ? 'ok' : 'bad'))
      ]));
      box.appendChild(h('p', { class: 'small muted', text: r.note }));
    }
    return box;
  }

  // The page is two independent panes, and the refresh only ever touches the
  // first one. The first version re-rendered EVERYTHING every 30 seconds, which
  // rebuilt the editor underneath whoever was using it: the feed picker snapped
  // back to the first feed, the caret jumped out of the field being typed in,
  // and unsaved edits vanished. A status poll must not be able to do that.
  var timer = null;
  var statusPane = null, editorPane = null, editor = null;
  // Results of the two on-demand checks. Held out here because the status pane
  // redraws every 30 seconds: kept inside it, an answer would vanish while you
  // were reading it.
  var jetstream = { readings: null, busy: false, chosen: null };
  var identity = { result: null, busy: false, error: null };

  function schedule() { timer = setTimeout(tick, 30000); }

  function tick() {
    // Even a status-only redraw is movement on the screen. While there are
    // unsaved edits, hold still entirely — the editor says so in its toolbar.
    if (editor && editor.isDirty()) { schedule(); return; }
    load();
  }

  function panes() {
    if (statusPane) return;
    app.innerHTML = '';
    statusPane = h('div', {}, []);
    editorPane = h('div', {}, []);
    app.appendChild(statusPane);
    app.appendChild(editorPane);
  }

  function load() {
    if (timer) { clearTimeout(timer); timer = null; }
    api('status').then(function (r) {
      if (r.status === 401) { renderLogin(); return; }
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json().then(function (b) {
        panes();
        renderStatus(b.status, statusPane);
        // Built once. Its own Reload button is how it refetches — never a poll.
        if (!editor) editor = renderConfigEditor(b.status, editorPane);
        schedule();
      });
    }).catch(function (e) {
      if (!statusPane) {
        app.innerHTML = '';
        app.appendChild(h('div', { class: 'card pad' }, [
          h('p', { class: 'err', text: 'Could not load status: ' + e.message })
        ]));
      }
      schedule();
    });
  }

  load();
})();
</script>
</body>
</html>
`
