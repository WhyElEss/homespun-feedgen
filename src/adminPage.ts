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
  input.account { color: var(--muted); cursor: default; margin-bottom: .5rem; }
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
    // There is no account to choose: the password is the only credential. This
    // field exists solely so password managers have an identity to file the
    // entry under — many will not offer to save a password-only form, and some
    // save it against a blank user and then never offer to fill it again. It is
    // readonly, skipped by Tab, and never sent to the server.
    var user = h('input', { type: 'text', autocomplete: 'username', value: 'admin',
                            readonly: 'readonly', tabindex: '-1', 'aria-label': 'Account' });
    user.className = 'account';
    var input = h('input', { type: 'password', autocomplete: 'current-password',
                             'aria-label': 'Admin password', placeholder: 'Password' });
    var err = h('div', { class: 'err', text: message || '' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'login card pad' }, [
      h('h1', { text: 'feedgen admin' }),
      h('p', { text: 'Config and status for the feed generator.' }),
      user, input, h('div', { class: 'row' }, [btn]), err
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

    renderConfigEditor(s);

    app.appendChild(h('footer', {
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
  function renderConfigEditor(s) {
    var full = null, digest = null, writable = false, key = null, draft = null;

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
    var toolbar = h('div', { class: 'toolbar' }, [
      btnValidate, btnMeasure, h('span', { class: 'spacer' }, []), btnReload, btnSave
    ]);

    app.appendChild(h('h2', { text: 'Filters' }));
    app.appendChild(picker);
    app.appendChild(blocks);
    app.appendChild(toolbar);
    app.appendChild(msg);
    app.appendChild(results);

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

      // Input — the closest thing this engine has to SkyFeed's source block.
      var retType = (draft.retention && draft.retention.type) || 'hours';
      var retVal = (draft.retention && draft.retention.value) || 72;
      var num = h('input', { type: 'number', min: '1', class: 'num' });
      num.value = String(retVal);
      num.addEventListener('input', function () {
        var v = parseInt(num.value, 10);
        if (v > 0) draft.retention = { type: retType, value: v };
      });
      var unit = h('select', {}, []);
      [['hours', 'hours old'], ['count', 'newest posts']].forEach(function (o) {
        var opt = h('option', { value: o[0], text: o[1] });
        if (o[0] === retType) opt.setAttribute('selected', 'selected');
        unit.appendChild(opt);
      });
      unit.addEventListener('change', function () {
        draft.retention = { type: unit.value, value: parseInt(num.value, 10) || 72 };
        redraw();
      });
      blocks.appendChild(block('Input', [
        h('div', { class: 'row wrapx' }, [
          h('span', { text: 'Entire network, continuously. Keep' }), num, unit
        ]),
        h('p', { class: 'small muted', text:
          'There is no time window on the source: this box reads the firehose ' +
          'without pause. Retention is what bounds the feed, and the hourly GC ' +
          'enforces it.' })
      ]));

      var name = h('input', { type: 'text', placeholder: 'display name' });
      name.value = draft.displayName || '';
      name.addEventListener('input', function () {
        if (name.value) draft.displayName = name.value; else delete draft.displayName;
      });
      blocks.appendChild(block('Feed name', [name, h('p', { class: 'small muted', text:
        'Shown here only. The name readers see lives in the feed record on your ' +
        'PDS — change it with setFeedDescription/repointFeed, not from this page.' })]));

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

      var pin = h('input', { type: 'text', placeholder: 'at://…/app.bsky.feed.post/… (optional)' });
      pin.value = draft.pinnedPost || '';
      pin.addEventListener('input', function () {
        if (pin.value) draft.pinnedPost = pin.value.trim(); else delete draft.pinnedPost;
      });
      blocks.appendChild(block('Pinned post', [pin,
        h('p', { class: 'small muted', text:
          'Served first on page 1 with the Pinned badge. Whether it survives ' +
          'un-pinning depends on whether it matches this feed on its own.' })]));

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
    }

    function selectFeed(k) {
      key = k;
      draft = JSON.parse(JSON.stringify(full.feeds[k] || {}));
      results.innerHTML = '';
      say('');
      redraw();
    }

    feedSel.addEventListener('change', function () { selectFeed(feedSel.value); });

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

    btnReload.addEventListener('click', load);

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
      api('lab/measure', { feed: key, filters: assembled() }).then(function (r) {
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
