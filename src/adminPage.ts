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
<!-- Same reasoning as proxying the avatars rather than linking them at the CDN:
     nothing this page touches should tell anyone that this admin URL exists, or
     who is reading it. Covers the links out to bsky.app added below. -->
<meta name="referrer" content="no-referrer">
<title>feedgen admin</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68; --line: #e2e2df;
    --card: #ffffff; --accent: #2563eb; --ok: #157f3d; --warn: #9a6700; --bad: #b42318;
    /* Text ON a filled accent or ok surface. Both themes keep their accents at
       opposite ends of the scale — dark on light here, light on dark below —
       so one variable serves both fills. It exists because white-on-accent was
       carried into the dark theme unchanged, where the accents are LIGHTER:
       white on #6ea8fe measures 2.4:1 and white on #4ec27f 2.25:1, against the
       4.5:1 that ordinary text needs. Dark ink on those same fills is 7.8:1
       and 8.4:1. Light theme is unchanged at 4.9:1 and 5.1:1. */
    --on-fill: #ffffff;
    /* The chart keeps ONE palette in BOTH themes, by request. --accent and
       --warn flip with the theme, which is right for pills and buttons and
       wrong for a data series: the same bar should not change hue because the
       phone went dark. These are the dark theme's blue and a single orange.
       The cost is honest and accepted: on the light theme they measure 2.4:1
       and 2.8:1 against the card, below the 3:1 usually asked of graphical
       objects. They are large solid shapes, every value is also in the tooltip
       and the list below, and blue against orange survives the common colour
       blindness — which blue against green would not. */
    --chart-stored: #6ea8fe;
    --chart-removed: #f97316;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a; --fg: #e8e8e6; --muted: #9a9a97; --line: #2c2e31;
      --card: #1e2022; --accent: #6ea8fe; --ok: #4ec27f; --warn: #e0b341; --bad: #ff6b5e;
      --on-fill: #0b1220;
    }
  }
  * { box-sizing: border-box; }
  /* One gutter, used on both sides and nowhere else, so the page cannot end up
     with more air on one edge than the other. */
  :root { --gutter: 1rem; }
  /* iOS Safari IGNORES overflow-x: hidden on html and body — a long-standing,
     well-documented quirk, and the reason an earlier attempt at exactly this
     did nothing. The documented remedy is to put it on a wrapper element
     instead, which is what <main> is here. Kept on body as well for the
     browsers that do honour it.
     https://www.codestudy.net/blog/disabling-horizontal-scroll-on-an-iphone-website/ */
  html, body { max-width: 100%; overflow-x: hidden; }
  body {
    margin: 0; padding: 1.5rem var(--gutter) 3rem; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; width: 100%;
         position: relative; overflow-x: hidden; overscroll-behavior-x: none; }
  h1 { font-size: 1.1rem; margin: 0; letter-spacing: .01em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 2rem 0 .6rem; font-weight: 600; }
  /* center, NOT baseline: this row mixes a 1.1rem title, a .85em mono box name
     and a pill, and a pill is a box rather than a word — its border and padding
     sit outside the text whose baseline would be matched. On baseline the three
     centres measured 42.89 / 44.76 / 44.70, i.e. the title rode ~2px high and
     the oval read as lifted off the line. Centring makes all three agree. */
  header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
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
  /* width AND max-width, so the card is sized by its container and never by the
     table inside it — that is what keeps the scrolling local to the card. */
  /* Deliberately without the legacy webkit momentum-scroll declaration: it has
     been unnecessary since iOS 13 made momentum the default, and it is
     documented as able to override overflow-x on ancestors — the opposite of
     what this card wants. The test asserts it stays absent. */
  .wrap { overflow-x: auto; width: 100%; max-width: 100%; }
  /* A table squeezed into a phone stops being a table: the columns collapse to
     a letter apiece. Give it a floor and let its own container scroll — the
     card still lines up with everything else, only its contents slide. */
  .wrap table { min-width: 30rem; }
  /* nowrap or it is not a pill: in a narrow column the label wraps onto two
     lines and the 999px radius turns the whole thing into a circle. */
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px;
          font-size: .75rem; font-weight: 600; border: 1px solid currentColor;
          white-space: nowrap; }
  .pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); } .pill.bad { color: var(--bad); }
  .pill.idle { color: var(--muted); }
  /* The word that actually fired. It is the answer to "why is my post not in
     the feed", so it is the thing the eye should land on. */
  code.hit { background: var(--bg); border: 1px solid var(--line);
             border-radius: 5px; padding: .05rem .3rem; font-weight: 600;
             color: var(--fg); }
  /* A cursor left behind by an endpoint switch: still worth showing, but it
     must not compete for attention with the one that is actually running. */
  .card.inactive { opacity: .65; }
  .card.inactive .note { margin: .6rem 0 0; padding-top: .5rem;
                         border-top: 1px dashed var(--line); }
  button {
    font: inherit; padding: .45rem .9rem; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-fill); }
  /* Save writes a file on this box; this one writes to your repository on the
     PDS, under credentials you just typed. They were the same blue button.
     Different weight, so the hand does not treat them as the same act. */
  button.outgoing { background: none; color: var(--warn); border-color: var(--warn);
                    font-weight: 600; }
  button:disabled { opacity: .55; cursor: default; }
  /* 16px on every control, always, and NEVER via 'font: inherit'.
     iOS Safari zooms the whole page in when focus enters a control under 16px
     and does not zoom back out when focus leaves — a documented WebKit
     behaviour, not something a page can undo. Body text here is 15px, so
     'font: inherit' was handing these fields exactly the size that triggers it.
     An earlier attempt set 16px from inside a media query, which lost the
     cascade: input[type=text] is specificity 0-1-1 and input is 0-0-1, and
     a media query adds none. The two fields that mattered most — password and
     the 2FA code — stayed 15px while everything else was fixed. */
  input[type=password], input[type=text] {
    font-family: inherit; font-size: 16px;
    width: 100%; padding: .55rem .7rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  form.login input { margin-bottom: .5rem; }
  /* The re-authentication prompt. Kept above .hidden in the sheet: both are
     single-class selectors, so whichever comes last wins, and .hidden has to. */
  .modal { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 50;
           background: rgba(0, 0, 0, .5); display: flex; align-items: center;
           justify-content: center; padding: var(--gutter); overflow-y: auto; }
  .modal form { max-width: 21rem; width: 100%; }
  .modal input { margin-bottom: .5rem; }
  .hidden { display: none; }
  form.login { max-width: 21rem; margin: 4rem auto; }
  form.login p { color: var(--muted); font-size: .85rem; margin: .2rem 0 1rem; }
  .row { display: flex; gap: .5rem; align-items: center; margin-top: .7rem; }
  .err { color: var(--bad); font-size: .85rem; min-height: 1.2em; margin-top: .6rem; }
  .muted { color: var(--muted); }
  /* Was .82rem. Almost every explanation on this page is .small AND muted, so
     the text carrying the reasoning was the least legible thing on it. */
  .small { font-size: .875rem; }
  /* Prose stops being readable somewhere past 75 characters and <main> is 62rem
     wide, which ran these notes to about 110. Only paragraphs — tables, rows
     and fields still want the full width. */
  p.small { max-width: 68ch; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 16px;
    width: 100%; min-height: 24rem; padding: .7rem; border-radius: 8px; tab-size: 2;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    line-height: 1.45; resize: vertical;
  }
  /* .5rem, NOT the .55rem the inputs use, and the difference is not a typo: a
     select's content box measures 21px where an input's is 19px, so equal
     padding gives unequal boxes. Both land on 39px, which is what matters —
     the Lab puts an input, a select and a button on one line. Match the
     RENDERED height, not the declaration. */
  select { font-family: inherit; font-size: 16px; padding: .5rem .5rem; border-radius: 7px;
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
  /* Same padding as the input[type=password] rule above, deliberately: both
     rules are 0-1-1, so this one wins for text fields, and while it said
     .45rem a text input measured 35px against a password field's 39px and a
     button's 39px. Any row mixing them — the two-factor row mixes all three —
     came out visibly stepped. If one of these paddings changes, change both. */
  input[type=text], input[type=number] {
    font-family: inherit; font-size: 16px; padding: .55rem .7rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  input[type=text] { width: 100%; }
  input.num { width: 6rem; }
  /* margin-top or the picker sits flush on the header's rule — measured 0px,
     which reads as the select hanging off the border. 1rem is the gap the tabs
     already keep below the picker, so the row sits evenly between the two. */
  .picker { display: flex; align-items: center; gap: .6rem;
            margin: 1rem 0 .8rem; }
  .picker label { color: var(--muted); font-size: .82rem; }
  /* min-width: 0 is the whole fix — without it a flex item refuses to shrink
     below its content, and a <select> counts its longest option as content. */
  .picker select { flex: 1; min-width: 0; max-width: 32rem; }
  .pickernote { margin: -.4rem 0 .8rem; }
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

  /* ── tabs ────────────────────────────────────────────────────────────────
     The page was one scroll of eight sections, so the thing you came to do was
     always below the thing you read once a week. Switching tabs only toggles
     .hidden — nothing is rebuilt, so an unsaved edit, a half-typed pattern and
     a 2FA enrolment all survive being navigated away from and back. */
  .tabs { display: flex; gap: .2rem; margin: 1rem 0 1.25rem; flex-wrap: nowrap;
          overflow-x: auto; border-bottom: 1px solid var(--line); }
  .tabs button { border: none; background: none; color: var(--muted);
                 font-size: .9rem; white-space: nowrap; min-height: 44px;
                 padding: .5rem .8rem; border-radius: 7px 7px 0 0;
                 border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button[aria-selected="true"] { color: var(--fg); font-weight: 600;
                                       border-bottom-color: var(--accent); }

  /* ── the action bar ──────────────────────────────────────────────────────
     FIXED, not sticky: <main> carries overflow-x: hidden, which makes it a
     scroll container, and position: sticky then anchors to a scrollport the
     same size as its own content — i.e. does nothing at all. Fixed is not
     clipped by an ancestor's overflow, so it is the one that works here.
     .hasbar on <main> reserves the room it floats over. */
  .actions { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
             background: var(--card); border-top: 1px solid var(--line);
             padding: .6rem var(--gutter);
             padding-bottom: calc(.6rem + env(safe-area-inset-bottom)); }
  .actions-in { max-width: 62rem; margin: 0 auto; display: flex; gap: .5rem;
                align-items: center; flex-wrap: wrap; }
  .actions-in > * { min-width: 0; }
  .actions-in .spacer { flex: 1; }
  .actions .msg { margin-top: .5rem; max-height: 6rem; overflow-y: auto; }
  /* Both collapse to nothing rather than holding a row open while empty — and
     the margin goes with them, because it belongs to the element and not to
     the row that contains it. */
  .actions .msg:empty { display: none; }
  /* Beats button.linkish (0-1-1) on specificity, which is the point: the marker
     is a button so it can take you to the list, but it is a warning first. */
  .actions .warn-text { display: block; margin-bottom: .35rem; text-align: left;
                        color: var(--warn); }
  .actions .warn-text:empty { display: none; }
  ul.changes { margin: 0; padding-left: 1.15rem; }
  ul.changes li + li { margin-top: .2rem; }
  main.hasbar { padding-bottom: 5.5rem; }

  /* ── collapsed blocks ────────────────────────────────────────────────────
     Collapsing HIDES the body, it never removes it: a collapsed pattern keeps
     its own textarea, and reopening shows that node rather than a copy — same
     reason nothing else on this page is rebuilt under the person using it. */
  .btitle { border: none; background: none; color: var(--fg); text-align: left;
            padding: .15rem 0; display: flex; align-items: center; gap: .45rem;
            font-size: .92rem; font-weight: 600; min-width: 0; }
  /* DRAWN, not typed. It was the character ▸ — U+25B8 BLACK RIGHT-POINTING
     SMALL TRIANGLE, and "small" is the whole problem: the glyph is tiny inside
     its own em box, so no font-size makes it read as a control. Enlarging it
     from .8rem to .95rem changed nothing that mattered; it still looked like a
     bullet, and the operator could not work out how to open a block at all.
     A border triangle is sized in pixels, and rotating it is a stronger signal
     of state than swapping one character for another. */
  .btitle .caret { flex: 0 0 auto; width: 0; height: 0; margin-right: .2rem;
                   border-left: 9px solid currentColor;
                   border-top: 6px solid transparent;
                   border-bottom: 6px solid transparent;
                   color: var(--muted); transition: transform .12s ease; }
  .btitle[aria-expanded="true"] .caret { transform: rotate(90deg); }
  /* Says the row is a control before it is pressed, for anyone with a pointer. */
  .btitle:hover .caret, .btitle:hover .ptitle { color: var(--accent); }
  .btitle .ptitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bsub { margin: -.3rem 0 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; }
  .ghead { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap;
           margin: 1.4rem 0 .5rem; }
  .ghead > * { min-width: 0; }
  .gtitle { font-size: .82rem; text-transform: uppercase; letter-spacing: .06em;
            color: var(--fg); font-weight: 700; margin: 0; }
  .ghead .spacer { flex: 1; }
  .ghint { margin: -.2rem 0 .6rem; }
  .chips { display: flex; gap: .35rem; flex-wrap: wrap; }
  .chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px;
          border: 1px solid var(--line); background: var(--bg); color: var(--muted);
          white-space: nowrap; }
  /* Selected, not healthy. Green is what every pill on this page uses to mean
     "this is fine", and spending it on "you picked this one" made the two
     unreadable against each other. Selection is the accent. */
  .chip.on { background: var(--accent); border-color: var(--accent); color: var(--on-fill); }
  /* A chip that cannot be pressed must not look like the two beside it that
     can. This one is always on and has no control behind it, so it says so
     instead of sitting there ignoring taps. */
  .chip.locked { background: none; border-style: dashed; color: var(--muted);
                 font-weight: 400; }
  .chip:disabled { opacity: 1; }
  .trow { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .tlabel { font-size: .82rem; color: var(--muted); }
  .cbox { display: inline-flex; align-items: center; gap: .35rem; font-size: .85rem; }
  .cbox input { margin: 0; }
  .row.wrapx { flex-wrap: wrap; margin-top: 0; }
  /* The margin-top: 0 above is there so a row that OPENS a card does not push
     itself off the top edge. It was killing the gap on every other row too, so
     two rows in a row touched: on the Security card the password field sat
     flush against the "two-factor ON" pill with a measured 0px between them,
     which reads as one control growing out of another. */
  .row.wrapx:not(:first-child) { margin-top: .7rem; }
  /* A six-digit code is six characters wide, not the width of the card.
     input[type=text] is width: 100% for the login form, and inherited here it
     made every control in the row claim a full line — so a row meant to read
     as [password] [code] [button] stacked into three. */
  input.code { width: 9rem; flex: 0 0 auto; }
  .warn-text { color: var(--warn); }

  /* ── fitting a phone ─────────────────────────────────────────────────────
     Every horizontal overflow on this page has had the same two causes, and
     the feed picker was only the most visible instance:

       1. a flex or grid child will NOT shrink below its own content unless it
          is given min-width: 0 — true of a <select> with a long option, of a
          value in a key/value row, of a table cell;
       2. DIDs, at:// URIs and hostnames contain no spaces, so with nowhere to
          break they set a floor under the width no shrinking can get past.

     So: permission to shrink, and permission to break. */
  .kv { flex-wrap: wrap; }
  .kv dt { flex: 0 0 auto; }
  .kv dd { min-width: 0; overflow-wrap: anywhere; }
  /* Cells wrap at word boundaries and never mid-word: 'anywhere' here is what
     shattered "network" into "networ / k" and "SAMPLED" into three lines. Only
     the key/value rows, where a DID genuinely has nowhere else to break, keep
     the stronger rule. */
  th, td { overflow-wrap: break-word; }
  .row > *, .toolbar > *, .trow > *, .picker > *, .grid > * { min-width: 0; }
  input, select, textarea, img, pre { max-width: 100%; }
  pre.cmd { white-space: pre-wrap; word-break: break-all; }

  @media (max-width: 40rem) {
    :root { --gutter: .8rem; }
    body { padding: 1rem var(--gutter) 3rem; }
    /* Stacked, so a long value gets the full width instead of fighting its
       label for it across a flex row. */
    .kv { flex-direction: column; align-items: flex-start; gap: .05rem; }
    .kv dd { text-align: left; }
    .grid { grid-template-columns: 1fr; }
    .picker { flex-wrap: wrap; }
    .picker select { max-width: 100%; }
    table { font-size: .82rem; }
    th, td { padding: .5rem .45rem; }
    /* Narrower floor on a phone, so the scroll is short rather than absent. */
    .wrap table { min-width: 26rem; }
    h2 { margin-top: 1.5rem; }
    img.qr { width: 100%; max-width: 260px; height: auto; }
    /* Five labels have to fit ~360px before the strip starts scrolling. */
    .tabs button { font-size: .85rem; padding: .5rem .55rem; }
    /* The four actions on ONE row of a phone. They fit on width alone; it was
       the gaps between six flex items that pushed Save onto a second row, and
       a second row of a bar fixed to the bottom is screen nobody gets back. */
    .actions-in { gap: .35rem; }
    .actions-in button { padding: .45rem .6rem; }
    /* 44px is the documented minimum for a touch target and this page is used
       on a phone. Chips are exempt: three 44px pills in a row read as three
       buttons rather than one setting, so they get padding instead. The × gets
       its hit area back in margin, so nothing around it moves. */
    button:not(.chip):not(.x):not(.linkish):not(.btitle) { min-height: 44px; }
    /* Fields get the same target as the buttons they sit beside. A text field
       is every bit as much a touch target as a button, and giving the rule to
       buttons alone left every mixed row stepped by 5px — visible on the
       two-factor row, where a 39px code field sits next to a 44px button.
       textarea is excluded: it already has a min-height many times this. */
    input:not([type=file]), select { min-height: 44px; }
    .chip { padding: .4rem .7rem; }
    /* Padding alone only got this to 33x37 — the glyph is small and the line
       height is 1. Ask for the target outright. */
    button.x { min-width: 44px; min-height: 44px; padding: 0;
               margin: -.35rem -.6rem; }
  }
  pre.cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem;
            background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
            padding: .5rem .6rem; margin: .4rem 0 0; overflow-x: auto; }
  button.linkish { border: none; background: none; color: var(--accent);
                   padding: .2rem 0; font-size: .85rem; }
  /* Fixed white plate whatever the theme: an inverted QR is one most scanners
     will not read. */
  img.qr { width: 200px; height: 200px; image-rendering: pixelated;
           background: #fff; border-radius: 8px; padding: 6px; display: block; }
  img.avatar { width: 72px; height: 72px; border-radius: 12px; object-fit: cover;
               border: 1px solid var(--line); background: var(--bg); }
  .grow { flex: 1; min-width: 12rem; }
  .flabel { display: block; font-size: .78rem; color: var(--muted);
            text-transform: uppercase; letter-spacing: .05em; margin-top: .3rem; }
  /* Cannot be typed into, so it cannot trigger the zoom — but spelled out
     rather than inherited, so nobody has to work that out again. */
  input[type=file] { font-family: inherit; font-size: .85rem; }

  /* ── the last 24 hours ───────────────────────────────────────────────────
     ONE CLOCK. Every column is an hour of ARRIVAL: the blue is what is still
     stored from that hour, the orange on top is what a sweep has since taken
     out of it. When a sweep ran is a different clock and is not on this chart
     — it is the time on each row of the list below. An earlier version drew
     those times as a second lane under the axis; it was pixel-exact against
     the columns and still read as broken, because a sweep at 03:40 empties a
     bar at 02:00 and its mark therefore stood next to, not above, the bar it
     had emptied. Do not put it back. */
  .act .cols, .act .axis {
    display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px;
  }
  .act .cols { align-items: end; }
  .act .track { height: 5.5rem; display: flex; flex-direction: column;
                justify-content: flex-end; background: var(--bg);
                border-radius: 3px 3px 0 0; }
  /* Retention has already cut these hours. An empty bar here means "removed on
     schedule", not "nothing arrived", and drawing it as a plain zero is exactly
     the lie this hatch exists to prevent. */
  .act .col.outside .track {
    background-image: repeating-linear-gradient(45deg,
      var(--line) 0 3px, transparent 3px 6px);
  }
  /* The hour still filling is always short. Unlabelled, that last stub reads as
     traffic falling off a cliff. */
  .act .col.partial .track { border: 1px dashed var(--line); }
  .act .col.hi .track { outline: 2px solid var(--chart-removed); outline-offset: 1px; }
  .act .seg { min-height: 2px; }
  .act .seg.stored { background: var(--chart-stored); border-radius: 2px 2px 0 0; }
  /* Orange rather than red: a sweep you asked for is not an error. */
  .act .seg.purged { background: var(--chart-removed); border-radius: 2px 2px 0 0; }
  .act .seg.purged + .seg.stored { border-radius: 0; }
  .act .axis { font-size: .68rem; color: var(--muted); margin-top: .25rem;
               font-variant-numeric: tabular-nums; }
  .act .axis span { text-align: center; overflow: hidden; }
  .act .keys { display: flex; gap: .8rem; flex-wrap: wrap; font-size: .75rem;
               color: var(--muted); margin: .1rem 0 .7rem; }
  .act .keys span { display: flex; align-items: center; gap: .3rem; }
  .act .sw { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
  .act .sw.stored { background: var(--chart-stored); }
  .act .sw.purged { background: var(--chart-removed); }
  .act .sw.outside { background-image: repeating-linear-gradient(45deg,
                       var(--line) 0 3px, transparent 3px 6px);
                     border: 1px solid var(--line); }
  .act .sw.partial { border: 1px dashed var(--muted); }
  .act .clocks { margin: .6rem 0 0; }
  .act .actlist { margin: .9rem 0 .1rem; }
  .act .onereason { margin-bottom: .3rem; }
  .act .sweep { border-top: 1px dashed var(--line); padding: .45rem 0 .2rem; }
  .act .sweep:first-child { border-top: none; }
  .act .swhead { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .act .swtime { font-variant-numeric: tabular-nums; font-weight: 600; }
  .act .swrows { margin: .4rem 0 .5rem; }
  .act .swrows td { vertical-align: top; }
  .act .swtext { color: var(--muted); }
  @media (max-width: 40rem) {
    /* 24 tracks across ~340px is 12px each. The bars survive that; the hour
       labels do not, so they thin out rather than overlapping into mush. */
    .act .track { height: 4.5rem; }
    .act .cols, .act .axis { gap: 1px; }
    .act .axis { font-size: .6rem; }
  }
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
  // A 401 from one of these means "those credentials are wrong", not "your
  // session ended" — a mistyped password must not open the re-auth prompt on
  // top of the login form it was typed into.
  function isAuthPath(path) {
    return path === 'api/login' || path === 'api/login-meta' || path === 'api/logout';
  }
  function call(path, init) {
    init = init || {};
    var hasBody = init.body !== undefined;
    return fetch(base + path, {
      method: init.method || (hasBody ? 'POST' : 'GET'),
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      if (r.status === 401 && !isAuthPath(path)) onUnauthorized();
      return r;
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
    statusPane = null; editorPane = null; editor = null; reauthOpen = false;
    chromeEl = null; navEl = null; barEl = null; securityPane = null; hosts = null;
    tabButtons = {}; tabPanels = {}; activeTab = 'filters';
    // Detached with the rest of the page. Left set, a late activity reply would
    // paint into a node nobody can see and the next sign-in would find a stale
    // host still holding the previous session's numbers.
    activityHost = null; activityFeed = null; activity.data = null;
    activity.error = null; activity.open = {};
    app.className = '';
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
                            placeholder: '123456' });
    var totpRow = h('div', {}, [
      h('label', { class: 'flabel', for: 'totp', text: 'Authenticator code' }), totp
    ]);
    totpRow.className = 'hidden';
    var err = h('div', { class: 'err', role: 'alert', text: message || '' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    // Real labels, not placeholders standing in for them: a placeholder is gone
    // the moment anything is typed, and this form is used rarely enough that
    // the 2FA field in particular has to still say what it wants once there are
    // digits in it.
    totp.setAttribute('id', 'totp');
    user.setAttribute('id', 'user');
    input.setAttribute('id', 'pass');
    var form = h('form', { class: 'login card pad' }, [
      h('h1', { text: 'feedgen admin' }),
      h('p', { text: 'Config and status for the feed generator.' }),
      h('label', { class: 'flabel', for: 'user', text: 'Username' }), user,
      h('label', { class: 'flabel', for: 'pass', text: 'Password' }), input,
      totpRow, h('div', { class: 'row' }, [btn]), err
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
    // Not on a narrow screen: autofocus there pops the keyboard over the form
    // before it has been read, and it is what triggered the iOS zoom at load.
    // The CSS above makes the zoom harmless either way; this keeps the page
    // still on arrival.
    var narrow = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 40rem)').matches
      : false;
    if (!narrow) user.focus();
  }

  // The session idles out after an hour, and the editor is very often the only
  // copy of an edit in progress. Replacing the whole page with the login form is
  // the right answer when there is nothing to lose and a destructive one when
  // there is — so which happens depends on whether there is unsaved work.
  //
  // NOTHING IS RETRIED. Re-sending the request that hit the 401 would mean
  // replaying a PUT, unasked, against a config that may have moved on in the
  // meantime — the exact clobber the digest guard exists to prevent. The
  // operator presses the button again, and the digest check does its job.
  var reauthOpen = false;
  function onUnauthorized() {
    if (editor && editor.isDirty()) { showReauth(); return; }
    // statusPane exists only once a status call has succeeded, so it is also
    // the answer to "was there a session to lose?" — a first visit gets the
    // plain form rather than being told something expired that never existed.
    renderLogin(statusPane ? 'Your session ended. Sign in again.' : '');
  }

  function showReauth() {
    if (reauthOpen) return;
    reauthOpen = true;
    var user = h('input', { type: 'text', autocomplete: 'username',
                            'aria-label': 'Username', placeholder: 'Username' });
    var pass = h('input', { type: 'password', autocomplete: 'current-password',
                            'aria-label': 'Admin password', placeholder: 'Password' });
    var totp = h('input', { type: 'text', autocomplete: 'one-time-code',
                            inputmode: 'numeric', maxlength: '6',
                            'aria-label': 'Authenticator code',
                            placeholder: '6-digit code' });
    var totpRow = h('div', {}, [totp]);
    totpRow.className = 'hidden';
    var err = h('div', { class: 'err', role: 'alert' });
    var btn = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'card pad' }, [
      h('h1', { text: 'Session expired' }),
      h('p', { class: 'small muted', text:
        'Your unsaved changes are still on the page behind this. Sign in, then ' +
        'press the same button again — nothing is re-sent for you, deliberately.' }),
      user, pass, totpRow, h('div', { class: 'row' }, [btn]), err
    ]);
    var overlay = h('div', { class: 'modal' }, [form]);

    var wantsTotp = false;
    api('login-meta').then(function (r) { return r.json(); }).then(function (b) {
      wantsTotp = !!(b && b.totpRequired);
      if (wantsTotp) totpRow.className = '';
    }).catch(function () { /* a sign-in attempt would say so anyway */ });

    form.addEventListener('submit', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      btn.disabled = true; err.textContent = '';
      var payload = { user: user.value, password: pass.value };
      if (wantsTotp) payload.totp = totp.value;
      api('login', payload).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        btn.disabled = false;
        if (res.status === 200) {
          pass.value = ''; totp.value = '';
          overlay.remove();
          reauthOpen = false;
          return;
        }
        if (res.body.needsTotp) {
          wantsTotp = true; totpRow.className = '';
          totp.value = ''; totp.focus();
        }
        err.textContent = res.body.error || 'Sign-in failed';
      }).catch(function () {
        btn.disabled = false; err.textContent = 'Network error';
      });
    });

    app.appendChild(overlay);
  }

  // The page chrome: who this box is, how old the reading is, and the two
  // buttons that are never about one tab in particular.
  function renderChrome(s, root) {
    root.innerHTML = '';
    var writable = s.service.writable;
    var boxPill = h('span', {
      class: 'pill ' + (writable ? 'ok' : 'warn'),
      // "primary" only means something relative to a standby, and this page
      // never talks to one: it answers for the box it is served from, whatever
      // that box's role is today. Say what the operator can DO here.
      text: writable ? 'edits allowed' : 'read-only'
    });
    var logout = h('button', { text: 'Sign out' });
    logout.addEventListener('click', function () {
      api('logout', {}).then(function () { renderLogin('Signed out.'); });
    });
    var refresh = h('button', { text: 'Refresh' });
    refresh.addEventListener('click', function () { load(); });

    stampEl = h('span', { class: 'small muted' });
    root.appendChild(h('header', {}, [
      h('h1', { text: 'feedgen admin' }),
      h('span', { class: 'mono muted', text: s.box.name }),
      boxPill,
      h('span', { class: 'spacer' }, []),
      stampEl, refresh, logout
    ]));
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function zeros24() { var a = [], i; for (i = 0; i < 24; i++) a.push(0); return a; }
  // Buckets arrive as UTC hour starts and are labelled in the reader's own
  // zone. On an offset that is not a whole number of hours the labels land on
  // the half hour, which is accurate rather than wrong — bucketing below the
  // hour would be real work for a cosmetic gain.
  function localHM(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '—';
    var dt = new Date(t);
    return pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }
  // at://<did>/app.bsky.feed.post/<rkey> — the author DID is in the URI, so a
  // removed post can still be opened even though its row is gone.
  function postLink(uri) {
    var s = String(uri || '');
    if (s.indexOf('at://') !== 0) return null;
    var parts = s.slice(5).split('/');
    if (parts.length < 3 || !parts[0] || !parts[2]) return null;
    return 'https://bsky.app/profile/' + parts[0] + '/post/' + parts[2];
  }

  // The series to draw. One feed, or every feed summed while the picker has
  // not reported one yet — summing is honest, it is what the box did, and it
  // beats an empty card for the moment before the config finishes loading.
  function activitySeries(key) {
    var out = { stored: zeros24(), purged: zeros24(), floor: null, mixed: false };
    var d = activity.data;
    if (!d) return out;
    var picked = [];
    (d.feeds || []).forEach(function (f) {
      if (!key || f.key === key) picked.push(f);
    });
    picked.forEach(function (f) {
      for (var i = 0; i < 24; i++) {
        out.stored[i] += (f.stored && f.stored[i]) || 0;
        out.purged[i] += (f.purged && f.purged[i]) || 0;
      }
      if (f.floor) out.mixed = true;
    });
    // A cut belongs to one feed's window. Applied to a total of four feeds it
    // would claim hours are missing from all of them, so the summed view says
    // so in words instead of hatching columns it cannot speak for.
    if (key && picked.length === 1) { out.floor = picked[0].floor; out.mixed = false; }
    return out;
  }

  // ── what MOVED in the last 24 hours, as against what the box IS
  //
  // The bars are what is stored, hour by hour. Stacked on each, in amber, the
  // posts that arrived in that hour and have since been swept — read back out
  // of the dumps purgePosts leaves beside the database.
  //
  // That second series is the reason this card exists. Blocking an account on
  // the strength of the one post you happened to see routinely removes several,
  // and nothing said so: the rows were gone from the table and the only record
  // was a file nobody opens. The ones you never saw were in readers' feeds the
  // whole time, which is the part worth knowing.
  function renderActivity() {
    activityHost = h('div', {}, []);
    paintActivity();
    return activityHost;
  }

  function paintActivity() {
    var host = activityHost;
    if (!host) return;
    host.innerHTML = '';
    var card = h('div', { class: 'card pad act' }, []);
    host.appendChild(card);

    if (activity.error) {
      card.appendChild(h('p', { class: 'err', role: 'alert',
        text: 'Could not load activity: ' + activity.error }));
      return;
    }
    var d = activity.data;
    if (!d) {
      card.appendChild(h('p', { class: 'small muted', text: 'Loading…' }));
      return;
    }

    var series = activitySeries(activityFeed), i, max = 1, anyPurged = false;
    for (i = 0; i < 24; i++) {
      max = Math.max(max, series.stored[i] + series.purged[i]);
      if (series.purged[i]) anyPurged = true;
    }
    // The first column whose hour begins before the cut, or -1. Also decides
    // whether the legend has anything to say about retention.
    var firstOutside = -1;
    if (series.floor) {
      for (i = 0; i < 24; i++) {
        if (d.hours[i] + ':00:00.000Z' < series.floor) firstOutside = i;
      }
    }

    // Only the keys that are actually on screen. Explaining two edge cases that
    // are not drawn cost three wrapped rows on a phone, which is a third of the
    // card spent on hypotheticals; on an ordinary day this is now one row.
    var keys = [h('span', {}, [h('i', { class: 'sw stored' }),
                               h('span', { text: 'stored' })])];
    if (anyPurged) {
      keys.push(h('span', {}, [h('i', { class: 'sw purged' }),
                               h('span', { text: 'removed by a purge' })]));
    }
    if (firstOutside >= 0) {
      keys.push(h('span', {}, [h('i', { class: 'sw outside' }),
                               h('span', { text: 'outside the retention window' })]));
    }
    keys.push(h('span', {}, [h('i', { class: 'sw partial' }),
                             h('span', { text: 'hour in progress' })]));
    card.appendChild(h('div', { class: 'keys' }, keys));

    var cols = h('div', { class: 'cols' }, []);
    var axis = h('div', { class: 'axis' }, []);
    var colEls = [];
    for (i = 0; i < 24; i++) {
      var iso = d.hours[i] + ':00:00.000Z';
      var start = new Date(Date.parse(iso));
      var st = series.stored[i], pu = series.purged[i];
      // A column whose hour BEGINS before the cut is only partly inside the
      // window, so its number cannot be trusted either. Marking it too beats
      // drawing a half-hour of data at full height.
      var outside = !!series.floor && iso < series.floor;
      var partial = i === 23;
      // The RANGE, not the start. "18:00" alone does not say whether the
      // column covers 17-18 or 18-19, and that is the first thing anyone
      // reading this chart asks. A bucket is [HH:00, HH+1:00): 18:00:00 is in
      // this column, 19:00:00 is in the next.
      var endH = new Date(Date.parse(iso) + 3600000);
      var title = pad2(start.getHours()) + ':00–' + pad2(endH.getHours()) +
                  ':00 — ' + st + ' stored';
      if (pu) title += ', ' + pu + ' removed by a purge';
      if (outside) title += ' (outside the retention window)';
      if (partial) title += ' (hour in progress)';
      var track = h('div', { class: 'track' }, []);
      if (pu) track.appendChild(h('div', { class: 'seg purged',
        style: 'height:' + Math.round(pu / max * 100) + '%' }));
      if (st) track.appendChild(h('div', { class: 'seg stored',
        style: 'height:' + Math.round(st / max * 100) + '%' }));
      var col = h('div', { class: 'col' + (outside ? ' outside' : '') +
                                  (partial ? ' partial' : ''),
                           title: title, 'data-hour': d.hours[i],
                           'data-stored': String(st), 'data-purged': String(pu) }, [track]);
      colEls.push(col);
      cols.appendChild(col);
      axis.appendChild(h('span', {
        text: start.getHours() % 6 === 0 ? pad2(start.getHours()) : '' }));
    }

    var events = d.events || [], withheld = d.withheld || [];
    var hourIndex = {};
    for (i = 0; i < 24; i++) hourIndex[d.hours[i]] = i;

    card.appendChild(cols);
    card.appendChild(axis);
    // ONE clock on this chart. There used to be a second lane under the axis
    // marking when each sweep RAN, and it was measured pixel-exact against the
    // columns — but a sweep at 03:40 removes a post that arrived at 02:xx, so
    // its mark sat one column away from the bar it had emptied and read as a
    // misalignment. It was reported as one, by someone who had read the
    // paragraph explaining it. A caption cannot rescue a picture that looks
    // wrong. The lane also said nothing the rest of the card does not: the
    // bars already show what was removed and from which hour, and each sweep's
    // own time is in the list below.
    card.appendChild(h('p', { class: 'small muted clocks', text:
      'Bars are placed by when a post arrived. A sweep takes posts from ' +
      'earlier hours, so the times below are when each sweep ran — open one ' +
      'to light up the hours it emptied.' }));

    if (series.mixed && !series.floor) {
      card.appendChild(h('p', { class: 'small muted', text:
        'One or more of these feeds has retention reaching into this window. ' +
        'Pick a single feed to see which hours it has already cut.' }));
    }

    function highlight(e, on) {
      var hours = {}, j;
      (e.rows || []).forEach(function (r) {
        if (activityFeed && r.feed !== activityFeed) return;
        hours[String(r.indexedAt).slice(0, 13)] = true;
      });
      for (j = 0; j < 24; j++) {
        if (!hours[d.hours[j]]) continue;
        colEls[j].className = colEls[j].className.split(' hi').join('') + (on ? ' hi' : '');
      }
    }

    // A sweep can take posts older than the chart. Seen on the live box: one
    // sweep removed three, of which two had arrived the previous day — so the
    // row says -3 while a single column lights up. Counting them is the
    // difference between "the chart disagrees with the number" and a fact.
    function olderThanChart(e) {
      var n = 0;
      (e.rows || []).forEach(function (r) {
        if (activityFeed && r.feed !== activityFeed) return;
        if (hourIndex[String(r.indexedAt).slice(0, 13)] === undefined) n++;
      });
      return n;
    }

    // The bars follow the picker; this list deliberately does NOT. A blocklist
    // entry sweeps whichever feeds the account reached, and hiding the ones you
    // do not happen to have selected would recreate, one level up, exactly the
    // blind spot this card was built to close. Each row names its feeds — but
    // under a chart headed "Radio", a row reading "Coffee 4" needs the scope
    // said out loud rather than inferred.
    var list = h('div', {}, []);
    if (events.length || withheld.length) {
      card.appendChild(h('div', { class: 'gtitle actlist', text: 'Purges — all feeds' }));
    }
    card.appendChild(list);
    if (!events.length && !withheld.length) {
      // Words, not a blank space. Nothing at all reads as something broken.
      list.appendChild(h('p', { class: 'small muted', text:
        'No posts were removed by a purge in the last 24 hours.' }));
    }

    // A sweep the cap refused deletes nothing, so it leaves no dump — this row
    // is the only trace of it anywhere the page can reach.
    function renderWithheld(w) {
      list.appendChild(h('div', { class: 'sweep' }, [
        h('div', { class: 'swhead' }, [
          h('span', { class: 'swtime', text: localHM(w.at) }),
          h('span', { class: 'pill warn', text: 'held back' }),
          h('span', { class: 'small muted', text: w.mode }),
          h('span', { class: 'small', text: w.count + ' of ' + w.stored +
                                            ' would have gone, cap ' + w.limit })
        ]),
        h('p', { class: 'small muted', text:
          'The safety cap refused this sweep, so nothing was deleted. A valid ' +
          'but wrong pattern is what that cap is for — check what it would ' +
          'take before running purgePosts by hand.' })
      ]));
    }

    // ONE list in time order, not applied-then-withheld. Rendering the two
    // kinds as separate runs put 15:10 above 10:05 under a chart whose whole
    // subject is when things happened.
    var entries = [];
    events.forEach(function (e) { entries.push({ at: e.at, ev: e }); });
    withheld.forEach(function (w) { entries.push({ at: w.at, wh: w }); });
    entries.sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : 0; });

    entries.forEach(function (entry) {
      if (entry.wh) { renderWithheld(entry.wh); return; }
      var e = entry.ev;
      var open = !!activity.open[e.at];
      var body = h('div', { class: open ? '' : 'hidden' }, []);
      var btn = h('button', { class: 'btitle', 'aria-expanded': open ? 'true' : 'false' }, [
        h('i', { class: 'caret' }),
        h('span', { class: 'ptitle', text: localHM(e.at) })
      ]);
      btn.addEventListener('click', function () {
        var now = !activity.open[e.at];
        activity.open[e.at] = now;
        btn.setAttribute('aria-expanded', now ? 'true' : 'false');
        body.className = now ? '' : 'hidden';
        highlight(e, now);
      });
      var where = [];
      (e.byFeed || []).forEach(function (f) {
        where.push((activityNames[f.feed] || f.feed) + ' ' + f.count);
      });
      list.appendChild(h('div', { class: 'sweep' }, [
        h('div', { class: 'swhead' }, [
          btn,
          h('span', { class: 'pill warn', text: e.kind }),
          h('span', { class: 'swtime', text: '−' + e.total }),
          h('span', { class: 'small muted', text: where.join(', ') })
        ]),
        body
      ]));

      // A blocklist sweep gives every row the same reason, so printing it under
      // each one is the same sentence four times. State it once and the rows
      // are just the posts — the lesson the pattern groups already learned,
      // where one rule repeated per block was the volume at which a hint stops
      // being read. A --rejected sweep can hit several patterns, so that case
      // keeps its per-row reason; so does a capped list, where "all of them"
      // would be a claim about rows that are not on screen.
      var reasons = {};
      (e.rows || []).forEach(function (r) { reasons[r.why] = true; });
      var reasonKeys = [];
      for (var rk in reasons) if (reasons.hasOwnProperty(rk)) reasonKeys.push(rk);
      var oneReason = (!e.omitted && reasonKeys.length === 1) ? reasonKeys[0] : null;
      if (oneReason) {
        body.appendChild(h('div', { class: 'small muted onereason',
          text: 'All removed: ' + oneReason }));
      }
      var older = olderThanChart(e);
      if (older) {
        body.appendChild(h('div', { class: 'small muted onereason', text:
          older + ' of these arrived before this window, so ' +
          (older === 1 ? 'it is' : 'they are') + ' not in the chart above.' }));
      }

      (e.rows || []).forEach(function (r) {
        var line = h('div', { class: 'small' }, [
          h('span', { class: 'mono', text: '@' + (r.handle || 'unknown') })
        ]);
        line.appendChild(document.createTextNode(' · arrived ' + localHM(r.indexedAt) +
          (activityFeed ? '' : ' · ' + (activityNames[r.feed] || r.feed)) + ' · '));
        var lk = postLink(r.uri);
        if (lk) {
          line.appendChild(h('a', { href: lk, target: '_blank',
            rel: 'noreferrer noopener', referrerpolicy: 'no-referrer', text: 'open ↗' }));
        }
        body.appendChild(line);
        if (r.text) body.appendChild(h('div', { class: 'small swtext', text: r.text }));
        if (!oneReason) {
          body.appendChild(h('div', { class: 'small muted', text: 'removed: ' + r.why }));
        }
      });
      if (e.omitted) {
        body.appendChild(h('p', { class: 'small warn-text', text:
          'and ' + e.omitted + ' more not listed here — the dump holds them all.' }));
      }
    });

    (d.notes || []).forEach(function (n) {
      card.appendChild(h('p', { class: 'small warn-text', text: n }));
    });
  }

  function renderStatus(s, root) {
    root.innerHTML = '';

    // The sweep list knows rkeys; readers know names.
    activityNames = {};
    (s.feeds || []).forEach(function (f) {
      activityNames[f.key] = f.displayName || f.key;
    });
    root.appendChild(h('h2', { text: 'Last 24 hours' }));
    root.appendChild(renderActivity());

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
      h('th', { text: 'Newest' }), h('th', { text: 'Pin' }), h('th', { text: '' })
    ]);
    var body = s.feeds.map(function (f) {
      // Reading the table and then hunting for the same feed in a dropdown was
      // two steps for one intention.
      var name = h('td', {}, []);
      var pick = h('button', { class: 'linkish', text: f.displayName || f.key });
      pick.addEventListener('click', function () {
        if (editor && editor.select) editor.select(f.key);
        showTab('filters');
      });
      name.appendChild(pick);
      if (!f.routed) {
        name.appendChild(document.createTextNode(' '));
        name.appendChild(h('span', { class: 'pill bad', text: 'not routed' }));
      }
      // The feed as readers see it. rel and the page-wide referrer policy are
      // both required: without them this link tells Bluesky the admin URL, and
      // the avatars are proxied precisely so that nothing here does.
      var open = h('a', { href: 'https://bsky.app/profile/' + s.service.publisherDid +
                                '/feed/' + f.key,
                          target: '_blank', rel: 'noreferrer noopener',
                          referrerpolicy: 'no-referrer',
                          class: 'small', text: 'open ↗' });
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
        h('td', { class: 'small', text: f.pinnedPost ? 'yes' : '—' }),
        h('td', {}, [open])
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
  function renderConfigEditor(s, hosts) {
    var full = null, digest = null, writable = false, key = null, draft = null;
    // A snapshot of the open feed as it was loaded or last saved. Anything
    // else means unsaved work, which freezes the status refresh.
    var pristine = '';
    function isDirty() { return !!draft && JSON.stringify(draft) !== pristine; }

    var feedSel = h('select', { id: 'feedsel', 'aria-label': 'Feed to edit' });
    var pickerNote = h('div', { class: 'small muted pickernote' });
    var picker = h('div', {}, [
      h('div', { class: 'picker' }, [
        h('label', { text: 'Editing feed', for: 'feedsel' }), feedSel
      ]),
      pickerNote,
    ]);
    var blocks = h('div', {}, []);
    // The pinned post lives on the Lab tab but edits the same draft as the
    // Filters tab, so it needs a host of its own that redraw() can clear —
    // otherwise switching feeds would leave the previous feed's pin on screen.
    var pinHost = h('div', {}, []);
    var changesCard = h('div', {}, []);
    // role=status, here and on every other .msg: this div is the whole of the
    // page's feedback — "Saved", "Valid", the error from a refused write — and
    // without it a screen reader is told none of it.
    var msg = h('div', { class: 'msg', role: 'status' });
    var undoBar = h('div', {}, []);
    var results = h('div', {}, []);

    // Short labels, because all four have to fit one row of a phone: wrapped
    // onto three rows this bar ate a third of the screen and still covered the
    // text it was floating over. The long form is in the title.
    var btnValidate = h('button', { title: 'Compile the candidate config without saving it',
                                    text: 'Validate' });
    var btnMeasure = h('button', { title: 'Replay this edit over the posts this feed already holds',
                                   text: 'Measure' });
    var btnSave = h('button', { class: 'primary', text: 'Save' });
    var btnReload = h('button', { title: 'Re-read filters.json from disk, discarding this draft',
                                  text: 'Reload' });
    var dirtyFlag = h('button', { class: 'linkish warn-text' });
    dirtyFlag.addEventListener('click', function () {
      showTab('filters');
      if (changesCard.scrollIntoView) changesCard.scrollIntoView({ block: 'center' });
    });
    function showDirty() {
      // It used to say "auto-refresh paused". There has been no auto-refresh
      // since af80d42 removed the timer, so it was describing a mechanism that
      // no longer exists.
      // By the name on the picker, not the rkey: the marker can be read from a
      // tab where the rkey is not on screen, and a record key identifies a feed
      // to the config, not to a person.
      var name = (full && full.feeds[key] && full.feeds[key].displayName) || key;
      var dirty = isDirty();
      var list = dirty ? changes() : [];
      // Belt and braces: the draft differs but nothing below recognised how.
      if (dirty && !list.length) list = ['An edit this summary does not model.'];
      dirtyFlag.textContent = dirty
        ? list.length + (list.length === 1 ? ' unsaved change to ' : ' unsaved changes to ') + name
        : '';
      paintChanges(list);
      paintBar();
    }

    // The picker is chrome, not part of a tab: Filters, Lab and Record all
    // answer for one feed, and which feed you mean does not change when you
    // move between them.
    hosts.picker.appendChild(picker);

    // The actions live in the bar fixed to the bottom of the window. They used
    // to sit halfway down the page, after fifteen cards, which meant the most
    // frequent thing anyone does here — Save — was reliably off screen, and so
    // was the only sign that there was anything to save.
    // Three rows, not one wrapping row. The marker names the feed, which runs
    // to about 230px — put it in with the buttons and they wrap, and a bar
    // fixed to the bottom of a phone spends that second row forever. On its own
    // line it collapses to nothing while there is nothing to say.
    hosts.actions.appendChild(h('div', { class: 'actions-in' }, [dirtyFlag]));
    hosts.actions.appendChild(h('div', { class: 'actions-in' }, [
      h('span', { class: 'spacer' }, []),
      btnValidate, btnMeasure, btnReload, btnSave
    ]));
    hosts.actions.appendChild(h('div', { class: 'actions-in' }, [msg]));

    // At the top, not the foot: it is what you want to read on arriving at this
    // tab, and reading it should not require scrolling past everything it is
    // summarising.
    hosts.filters.appendChild(changesCard);
    hosts.filters.appendChild(blocks);
    hosts.filters.appendChild(undoBar);
    hosts.filters.appendChild(results);
    // The record and the filters are different objects in different places — one
    // on the PDS, one in filters.json — and they now look it. Pressing Save can
    // no longer be mistaken for something that might publish, because the two
    // are not on the same screen any more.
    var recordHost = h('div', {}, []);
    // No heading above this one: the card already says what it is, and a tab
    // titled Record over a heading over a card saying the same thing three
    // times was three times too many.
    hosts.record.appendChild(recordHost);
    // First on the tab, ahead of the two diagnostics. It is the only thing here
    // that WRITES, and a control buried under two read-only panels is the
    // "nobody knows it exists" failure the bridgedPosts toggle already cost us.
    hosts.lab.appendChild(pinHost);
    renderProbe(hosts.lab);
    renderWhyNot(hosts.lab);
    renderWizard(hosts.record);

    // A message lands IN the bar, so writing one changes how tall it is.
    // ── what Save is about to do, in words
    //
    // The confirm() this replaces asked "Save <rkey>?" — the one thing the
    // operator already knew — and said nothing about the content. After
    // fifteen blocks nobody can list from memory what they touched, so the
    // dialog was answered yes every time, which is how a dialog stops being a
    // check and becomes a reflex. A list of the actual changes is what a
    // confirmation was supposed to be, and it is on screen the whole time
    // rather than in the way at the last moment.
    var TOGGLE_LABEL = { selfLabeledPosts: 'Self-labelled posts',
                         gifPosts: 'GIF posts', quotePosts: 'Quote posts',
                         bridgedPosts: 'Bridged posts' };
    var TOGGLE_DEFAULT = { selfLabeledPosts: 'exclude', gifPosts: 'allow',
                           quotePosts: 'allow', bridgedPosts: 'allow' };
    function shortP(p) {
      var t = String((p && (p.comment || p.pattern)) || '(empty)');
      return t.length > 44 ? t.slice(0, 44) + '…' : t;
    }
    function targetWords(p, kind) {
      var t = targetOf(p, kind);
      return t === 'text' ? 'post text'
        : t === 'text|alt_text' ? 'text + alt' : 'text + alt + links';
    }
    function flagsOf(p) { return p.flags === undefined ? 'iu' : p.flags; }

    // Pairing old against new, because there is no id to match on and none may
    // be invented — anything added to a pattern object gets written to
    // filters.json. Three passes, weakest last: same expression, then same
    // comment (the expression was edited but it is the same editorial rule),
    // then one-left-each-side, which is an edit to an uncommented pattern
    // rather than a removal and an unrelated addition.
    function patternChanges(oldList, newList, kind, out) {
      var olds = (oldList || []).slice(), news = (newList || []).slice();
      var pairs = [];
      function pairOff(match) {
        olds.slice().forEach(function (o) {
          var m = news.filter(function (n) { return match(o, n); })[0];
          if (!m) return;
          pairs.push([o, m]);
          olds.splice(olds.indexOf(o), 1);
          news.splice(news.indexOf(m), 1);
        });
      }
      pairOff(function (o, n) { return o.pattern === n.pattern; });
      pairOff(function (o, n) { return !!o.comment && o.comment === n.comment; });
      if (olds.length === 1 && news.length === 1) pairs.push([olds.pop(), news.pop()]);

      var word = kind === 'include' ? 'Keep' : 'Remove';
      pairs.forEach(function (pr) {
        var o = pr[0], n = pr[1], name = word + ' "' + shortP(n) + '"';
        if (o.pattern !== n.pattern) out.push(name + ': expression edited');
        if (targetOf(o, kind) !== targetOf(n, kind)) {
          out.push(name + ': target ' + targetWords(o, kind) + ' → ' + targetWords(n, kind));
        }
        if (flagsOf(o) !== flagsOf(n)) out.push(name + ': case sensitivity changed');
        if ((o.comment || '') !== (n.comment || '')) out.push(name + ': note changed');
      });
      olds.forEach(function (o) { out.push(word + ' "' + shortP(o) + '": REMOVED'); });
      news.forEach(function (n) { out.push(word + ' "' + shortP(n) + '": added'); });
    }

    function changes() {
      var out = [];
      if (!draft) return out;
      var was;
      try { was = JSON.parse(pristine); } catch (e) { return out; }

      var a = was.retention || {}, b = draft.retention || {};
      if (a.type !== b.type || a.value !== b.value) {
        out.push('Retention ' + (a.value === undefined ? 'unset' : a.value + ' ' + a.type) +
                 ' → ' + (b.value === undefined ? 'unset' : b.value + ' ' + b.type));
      }
      patternChanges(was.includePatterns, draft.includePatterns, 'include', out);
      patternChanges(was.excludePatterns, draft.excludePatterns, 'exclude', out);
      Object.keys(TOGGLE_LABEL).forEach(function (k) {
        var x = was[k] || TOGGLE_DEFAULT[k], y = draft[k] || TOGGLE_DEFAULT[k];
        if (x !== y) out.push(TOGGLE_LABEL[k] + ': ' + x + ' → ' + y);
      });
      if ((was.excludeListUri || '') !== (draft.excludeListUri || '')) {
        out.push(draft.excludeListUri ? 'Moderation list set' : 'Moderation list cleared');
      }
      if ((was.pinnedPost || '') !== (draft.pinnedPost || '')) {
        out.push(draft.pinnedPost ? 'Pinned post set' : 'Pinned post cleared');
      }
      if ((was.includeDids || []).join() !== (draft.includeDids || []).join()) {
        out.push('Author DIDs: ' + (was.includeDids || []).length + ' → ' +
                 (draft.includeDids || []).length);
      }
      return out;
    }

    // Rebuilt only when the wording actually changes, so typing inside one
    // pattern does not redraw this on every keystroke.
    var lastChangeKey = null;
    function paintChanges(list) {
      var k = list.length ? list.join('\\n') : '';
      if (k === lastChangeKey) return;
      lastChangeKey = k;
      changesCard.innerHTML = '';
      if (!list.length) return;
      changesCard.appendChild(h('div', { class: 'card pad', role: 'status' }, [
        h('div', { class: 'bhead' }, [
          h('span', { class: 'blabel', text: 'Unsaved changes (' + list.length + ')' })
        ]),
        h('ul', { class: 'changes' }, list.map(function (t) {
          return h('li', { class: 'small', text: t });
        })),
        h('p', { class: 'small muted', text:
          'Save writes filters.json on this box, keeping a backup of the ' +
          'current one first. It goes live within about ten seconds, and the ' +
          'auto-purge replays it over stored posts within five minutes.' })
      ]));
    }

    function say(t, cls) {
      msg.className = 'msg ' + (cls || '');
      msg.textContent = t;
      paintBar();
    }
    function busy(on) {
      [btnValidate, btnMeasure, btnSave, btnReload].forEach(function (b) { b.disabled = on; });
      if (!on) {
        btnSave.disabled = !writable;
        // The two slow ones say so on themselves while they run. A greyed-out
        // button with the explanation somewhere else on the page is how you
        // press it twice. Restored here so every exit path restores them.
        btnMeasure.textContent = 'Measure';
        btnSave.textContent = 'Save';
      }
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
    // opts.collapsible turns the label into a disclosure. The body is HIDDEN,
    // never removed — a collapsed pattern keeps the textarea it was typed into,
    // so reopening it shows that node and its undo history rather than a fresh
    // copy carrying the same characters.
    function block(label, controls, opts) {
      opts = opts || {};
      var body = h('div', { class: 'bbody' }, controls);
      var sub = null;
      var head = h('div', { class: 'bhead' }, []);

      if (opts.collapsible) {
        var open = !!opts.open;
        var caret = h('span', { class: 'caret', text: '' });
        var title = h('button', { class: 'btitle' }, [
          caret, h('span', { class: 'ptitle', text: label })
        ]);
        // A one-line preview of what is inside, so a shut block still says which
        // rule it is. Hidden when open, because the field below shows it.
        sub = opts.subtitle
          ? h('div', { class: 'mono small muted bsub', text: opts.subtitle })
          : null;
        var paint = function () {
          // The caret carries no text: it is drawn in CSS off aria-expanded,
          // which is the attribute a screen reader reads anyway.
          title.setAttribute('aria-expanded', open ? 'true' : 'false');
          body.className = 'bbody' + (open ? '' : ' hidden');
          if (sub) sub.className = 'mono small muted bsub' + (open ? ' hidden' : '');
        };
        title.addEventListener('click', function () { open = !open; paint(); });
        paint();
        head.appendChild(title);
      } else {
        head.appendChild(h('span', { class: 'blabel', text: label }));
      }

      if (opts.onRemove) {
        var x = h('button', { class: 'x', title: 'Remove this block',
                              'aria-label': 'Remove ' + label, text: '×' });
        x.addEventListener('click', opts.onRemove);
        head.appendChild(h('span', { class: 'spacer' }, []));
        head.appendChild(x);
      } else if (opts.fixed) {
        head.appendChild(h('span', { class: 'spacer' }, []));
        head.appendChild(h('span', { class: 'pill idle', text: 'fixed' }));
      }

      var kids = sub ? [head, sub, body] : [head, body];
      return h('div', { class: 'card pad block' + (opts.fixed ? ' inactive' : '') }, kids);
    }

    // What a shut pattern block calls itself. The comment first, because that is
    // where the editorial reason lives ("storefronts / deals / affiliate") and a
    // list of those reads as the policy it is; the expression itself otherwise;
    // and the position never, because order carries no meaning here and a "#3"
    // goes stale the moment anything above it is removed.
    function patternTitle(p) {
      var t = String(p.comment || p.pattern || '').trim();
      if (!t) return '(empty pattern)';
      return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
    function groupHead(title, addBtn, hint, counters) {
      var kids = [h('h3', { class: 'gtitle', text: title }),
                  h('span', { class: 'spacer' }, [])];
      if (counters) {
        // One press fills in every block's count. The corpus is fetched once
        // per feed and cached, so only the first of these is slow — which is
        // what makes a whole config worth measuring at all rather than one
        // expression at a time.
        var all = h('button', { text: 'Count all' });
        all.addEventListener('click', function () {
          all.disabled = true;
          var running = counters.map(function (fn) { return fn(); });
          Promise.all(running).then(function () { all.disabled = false; })
            .catch(function () { all.disabled = false; });
        });
        kids.push(all);
      }
      kids.push(addBtn);
      return h('div', {}, [
        h('div', { class: 'ghead' }, kids),
        h('p', { class: 'small muted ghint', text: hint })
      ]);
    }
    function patternSub(p) {
      if (!p.comment) return '';
      var t = String(p.pattern || '');
      return t.length > 80 ? t.slice(0, 80) + '…' : t;
    }

    function chip(text, on, onClick) {
      if (!onClick) {
        var locked = h('button', { class: 'chip locked', disabled: 'disabled',
                                   text: text + ' — always' });
        locked.disabled = true;
        return locked;
      }
      var b = h('button', { class: 'chip' + (on ? ' on' : ''), text: text });
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', onClick);
      return b;
    }
    // Repaints ONE chip. Toggling a target used to call redraw(), which rebuilt
    // every block on the page — and rebuilding a textarea throws away its undo
    // history, so a chip pressed halfway through writing an alternation cost
    // whoever pressed it their Cmd+Z. The page's own rule about not rebuilding
    // anything under someone using it holds when the trigger is that person too.
    function paintChip(b, on) {
      b.className = 'chip' + (on ? ' on' : '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // Removing a pattern is one small × away from an alternation built up over
    // months, and the draft is its only copy until Save. The block is HIDDEN
    // rather than dropped, so Undo puts back the very same node — text, caret
    // position and undo history included — instead of a reconstruction of it.
    var undoState = null;
    function removePattern(p, kind, el) {
      var list = (kind === 'include' ? draft.includePatterns : draft.excludePatterns) || [];
      var at = list.indexOf(p);
      if (at < 0) return;
      list.splice(at, 1);
      el.className = el.className + ' hidden';
      undoState = { p: p, kind: kind, at: at, el: el };
      paintUndo();
      showDirty();
    }
    function paintUndo() {
      undoBar.innerHTML = '';
      if (!undoState) return;
      var label = String(undoState.p.comment || undoState.p.pattern || '(empty pattern)');
      if (label.length > 48) label = label.slice(0, 48) + '…';
      var btn = h('button', { text: 'Undo' });
      btn.addEventListener('click', function () {
        var u = undoState;
        var list = u.kind === 'include'
          ? (draft.includePatterns = draft.includePatterns || [])
          : (draft.excludePatterns = draft.excludePatterns || []);
        list.splice(Math.min(u.at, list.length), 0, u.p);
        u.el.className = u.el.className.replace(' hidden', '');
        undoState = null;
        paintUndo();
        showDirty();
      });
      undoBar.appendChild(h('div', { class: 'card pad row wrapx', role: 'status' }, [
        h('span', { class: 'small', text: 'Removed: ' + label }), btn,
        h('span', { class: 'small muted',
                    text: 'Nothing is written until you press Save.' })
      ]));
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
    function patternBlock(p, kind, counters) {
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

      var altChip, linkChip;
      function setTarget() {
        p.target = link ? 'text|alt_text|link' : alt ? 'text|alt_text' : 'text';
        paintChip(altChip, alt);
        paintChip(linkChip, link);
        showDirty();
      }
      altChip = chip('Image Alt Text', alt, function () {
        alt = !alt; if (!alt) link = false; setTarget();
      });
      linkChip = chip('Link', link, function () {
        link = !link; if (link) alt = true; setTarget();
      });
      var chips = h('div', { class: 'chips' }, [
        chip('Post Text', true, null), altChip, linkChip
      ]);

      // The rule about ANY-of-these used to be repeated on every block. On the
      // Vinyl feed that is thirteen copies of one sentence, which is the volume
      // at which a hint stops being read at all. It is said once, in the group
      // header these blocks now sit under.
      var flagsRow = h('div', { class: 'row wrapx' }, [
        checkbox('Case sensitive', sensitive, function (on) {
          // Preserve any other flag someone set by hand; only 'i' is ours.
          var base = (p.flags === undefined ? 'iu' : p.flags).replace(/i/g, '');
          var next = on ? base : 'i' + base;
          if (next === 'iu') delete p.flags; else p.flags = next;
        })
      ]);

      // Counting this very pattern, without copying it into the Lab first.
      //
      // The method this whole project runs on is: edit a token, measure, decide.
      // It used to mean selecting the expression, switching to the Lab, pasting
      // it, and setting the target again by hand — four steps of clerical work
      // between having a question and having the answer, which is how measuring
      // stops happening. lab/probe already takes exactly what a block holds, so
      // the block can ask on its own behalf.
      //
      // For an exclude, the count IS the answer: that many stored posts leave.
      // A plain button, NOT a chip. The chips a few lines above are state — the
      // targets this pattern reads — and this is an action. They were the same
      // shape and sat in the same block.
      var countBtn = h('button', { text: 'Count matches' });
      var countOut = h('span', { class: 'small muted' });
      function run() {
        // A removed block keeps its node so Undo can restore it; it must not
        // still be answering questions in the meantime.
        var list = (kind === 'include' ? draft.includePatterns : draft.excludePatterns) || [];
        if (list.indexOf(p) < 0) return Promise.resolve();
        if (!String(p.pattern || '').trim()) {
          countOut.className = 'small muted'; countOut.textContent = '';
          return Promise.resolve();
        }
        countBtn.disabled = true;
        countOut.className = 'small muted'; countOut.textContent = 'counting…';
        return call('lab/probe', { body: { feed: key, pattern: p.pattern,
          flags: p.flags === undefined ? 'iu' : p.flags,
          target: targetOf(p, kind) } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          countBtn.disabled = false;
          if (res.status !== 200) {
            countOut.className = 'small warn-text'; countOut.textContent = res.body.error;
            return;
          }
          var x = res.body.result;
          countOut.className = 'small ' + (x.hits ? '' : 'muted');
          countOut.textContent = kind === 'exclude'
            ? x.hits + ' of ' + x.stored + ' stored would go (' + x.hitsPct + '%)'
            : 'touches ' + x.hits + ' of ' + x.stored + ' stored (' + x.hitsPct + '%)';
        }).catch(function (e) {
          countBtn.disabled = false;
          countOut.className = 'small warn-text';
          countOut.textContent = 'Network error: ' + e.message;
        });
      }
      countBtn.addEventListener('click', run);
      if (counters) counters.push(run);

      // A block with something in it opens shut; one just added opens open,
      // because the reason it exists is that something is about to be typed.
      var el = block(
        patternTitle(p),
        [area, h('div', { class: 'trow' }, [h('span', { class: 'tlabel', text: 'Target' }), chips]),
         flagsRow, comment,
         h('div', { class: 'row wrapx' }, [countBtn, countOut])],
        { onRemove: function () { removePattern(p, kind, el); },
          collapsible: true, open: !p.pattern, subtitle: patternSub(p) }
      );
      return el;
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

    // The value control for whichever retention unit is chosen. Split out of
    // redraw() because switching the unit used to rebuild every block on the
    // page to replace this one field.
    // Read, never write: redraw() must not touch the draft. Defaulting a missing
    // retention INTO it would mark a feed that has none as edited the instant it
    // is opened, and then save a key nobody added.
    function retentionType() {
      return (draft.retention && draft.retention.type) || 'hours';
    }
    function retentionValue() {
      var retType = retentionType();
      var retVal = (draft.retention && draft.retention.value) || 72;
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
        value = h('select', { 'aria-label': 'Keep posts for' }, []);
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
        value = h('input', { type: 'number', min: '1', class: 'num',
                             'aria-label': 'Posts to keep' });
        value.value = String(retVal);
        value.addEventListener('input', function () {
          var v = parseInt(value.value, 10);
          if (v > 0) draft.retention = { type: 'count', value: v };
        });
      }
      return value;
    }

    function redraw() {
      blocks.innerHTML = '';
      pinHost.innerHTML = '';
      // The hidden nodes an Undo would have restored went with it.
      undoState = null;
      paintUndo();
      if (!draft) return;

      // Input — the closest thing this engine has to SkyFeed's source block.
      var unit = h('select', { 'aria-label': 'Retention unit' }, []);
      [['hours', 'by age'], ['count', 'by count']].forEach(function (o) {
        var opt = h('option', { value: o[0], text: o[1] });
        if (o[0] === retentionType()) opt.setAttribute('selected', 'selected');
        unit.appendChild(opt);
      });
      var valueSlot = h('span', {}, [retentionValue()]);
      var unitNote = h('span', { class: 'small muted',
        text: retentionType() === 'count' ? 'newest posts' : '' });
      unit.addEventListener('change', function () {
        // The two units do not convert into each other — 500 posts is not 500
        // hours — so switching picks that unit's usual value rather than
        // carrying a number across that would mean something else.
        draft.retention = unit.value === 'hours'
          ? { type: 'hours', value: 72 }
          : { type: 'count', value: 500 };
        valueSlot.innerHTML = '';
        valueSlot.appendChild(retentionValue());
        unitNote.textContent = unit.value === 'count' ? 'newest posts' : '';
        showDirty();
      });

      blocks.appendChild(block('Input', [
        h('div', { class: 'row wrapx' }, [
          h('span', { text: 'Entire network, continuously. Keep' }),
          unit, valueSlot, unitNote
        ]),
        h('p', { class: 'small muted', text:
          'There is no time window on the source: this box reads the firehose ' +
          'without pause. Retention is what bounds the feed, and the hourly GC ' +
          'enforces it.' })
      ]));

      // No editor for filters.json's displayName. It only labels log lines and
      // the picker above, so offering a field invited renaming a feed for
      // nobody's benefit. The value already on disk is carried through
      // untouched, because draft starts as a copy of the whole feed object.

      // Each group gets a container of its own, so "+ Add" can append into it
      // instead of calling redraw() — which is the last interactive path that
      // used to rebuild the page under whoever was typing. The button lives in
      // the group header rather than at the foot of the page, where it used to
      // sit behind three cards of read-once explanation.
      var incBox = h('div', {}, []);
      var incCounters = [];
      var addInc = h('button', { text: '+ Add pattern' });
      addInc.addEventListener('click', function () {
        draft.includePatterns = draft.includePatterns || [];
        var p = { pattern: '' };
        draft.includePatterns.push(p);
        incBox.appendChild(patternBlock(p, 'include', incCounters));
        showDirty();
      });
      (draft.includePatterns || []).forEach(function (p) {
        incBox.appendChild(patternBlock(p, 'include', incCounters));
      });
      blocks.appendChild(groupHead('Keep', addInc,
        'A post enters the feed if ANY of these match. Order does not matter. ' +
        'Counting an include says what it touches of what is already here — it ' +
        'cannot say what it would newly bring in, because those posts were ' +
        'never stored.', incCounters));
      blocks.appendChild(incBox);

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

      var excBox = h('div', {}, []);
      var excCounters = [];
      var addExc = h('button', { text: '+ Add pattern' });
      addExc.addEventListener('click', function () {
        draft.excludePatterns = draft.excludePatterns || [];
        var p = { pattern: '' };
        draft.excludePatterns.push(p);
        excBox.appendChild(patternBlock(p, 'exclude', excCounters));
        showDirty();
      });
      (draft.excludePatterns || []).forEach(function (p) {
        excBox.appendChild(patternBlock(p, 'exclude', excCounters));
      });
      blocks.appendChild(groupHead('Remove', addExc,
        'A post is dropped if ANY of these match. Order does not matter. ' +
        'Counting an exclude is exact: that many stored posts would leave.',
        excCounters));
      blocks.appendChild(excBox);

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

      blocks.appendChild(selectBlock('Remove if — item is bridged from the fediverse',
        draft.bridgedPosts || 'allow',
        [['allow', 'allow them'], ['exclude', 'remove them'], ['only', 'ONLY them']],
        function (v) { draft.bridgedPosts = v; },
        'Mastodon and other fediverse accounts federated in by Bridgy Fed. ' +
        'Matched on the record itself (bridgyOriginalUrl), never on the handle: ' +
        'the filter never sees a handle, and a bridge whose handle fails to ' +
        'resolve shows up as handle.invalid rather than as ap.brid.gy.'));

      var listUri = h('input', { type: 'text', placeholder: 'at://…/app.bsky.graph.list/…' });
      listUri.value = draft.excludeListUri || '';
      listUri.addEventListener('input', function () {
        if (listUri.value) draft.excludeListUri = listUri.value.trim();
        else delete draft.excludeListUri;
      });
      blocks.appendChild(block('Remove — list of users', [listUri,
        h('p', { class: 'small muted', text:
          'Read from the AppView and refreshed hourly, so a newly added account ' +
          'is not blocked immediately. The service itself never removes posts ' +
          'already stored — but auto-purge on the host notices the list change ' +
          'and sweeps them within about five minutes.' })]));

      var pin = h('input', { type: 'text',
        placeholder: 'https://bsky.app/profile/…/post/… — or an at:// URI' });
      pin.value = draft.pinnedPost || '';
      var pinMsg = h('div', { class: 'small muted' });
      var pinBtn = h('button', { text: 'Resolve' });
      // Emptying the field has always un-pinned the feed, and nothing on the
      // page ever said so — so in practice the only un-pinning anyone found was
      // replacing the pin with a different post, or deleting the post itself.
      // Same class as the bridgedPosts toggle that shipped without a control:
      // a capability with no affordance is not shipped.
      var pinClear = h('button', { text: 'Remove pin',
                                   title: 'Take the pinned post off this feed' });
      // What Remove took off, kept so it can go back without a Reload — which
      // would discard every other unsaved edit on the way. Same reasoning as
      // the undo on removing a pattern.
      var pinRemoved = null;

      function applyPin(v) {
        if (v) draft.pinnedPost = v; else delete draft.pinnedPost;
      }
      // Never textContent on this node: it carries an Undo button after a
      // removal, and mixing the two ways of writing to it is how that button
      // would survive in one browser and vanish in another.
      function sayPin(nodes, bad) {
        pinMsg.className = 'small ' + (bad ? 'warn-text' : 'muted');
        pinMsg.innerHTML = '';
        nodes.forEach(function (n) { pinMsg.appendChild(n); });
      }
      function pinText(t, bad) { sayPin([h('span', { text: t })], bad); }
      // Visible and disabled rather than hidden while there is no pin: someone
      // who has never un-pinned anything has to be able to see that it is
      // possible, which is the whole reason this button exists.
      function paintPin() {
        var has = !!pin.value.trim();
        pinClear.disabled = !has;
        pinBtn.disabled = !has;
      }
      pin.addEventListener('input', function () {
        pinRemoved = null;
        applyPin(pin.value.trim());
        paintPin();
      });
      pinClear.addEventListener('click', function () {
        var was = pin.value.trim();
        if (!was) return;
        pinRemoved = was;
        pin.value = '';
        applyPin('');
        paintPin();
        var undo = h('button', { class: 'linkish', text: 'Undo' });
        undo.addEventListener('click', function () {
          if (!pinRemoved) return;
          pin.value = pinRemoved;
          applyPin(pinRemoved);
          pinRemoved = null;
          paintPin();
          pinText('Pin restored. Nothing has been saved yet either way.');
          showDirty();
        });
        sayPin([
          h('span', { text: 'Pin removed from the draft — press Save to apply it. ' }),
          undo,
        ]);
        showDirty();
      });
      function resolvePin() {
        var v = pin.value.trim();
        if (!v) { pinText(''); return; }
        pinBtn.disabled = true;
        pinText('Resolving…');
        call('resolve/post', { body: { input: v } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          paintPin();
          if (res.status !== 200) { pinText(res.body.error, true); return; }
          var post = res.body.post;
          pin.value = post.uri; applyPin(post.uri); pinRemoved = null;
          paintPin(); showDirty();
          if (post.exists) {
            pinText('@' + post.handle + ' — ' + post.text);
          } else {
            pinText(
              'That URI is well formed, but there is no such post right now. A ' +
              'pin pointing at a deleted post is dropped during hydration with ' +
              'nothing in the log — it simply never appears.', true);
          }
        }).catch(function (e) {
          paintPin();
          pinText('Network error: ' + e.message, true);
        });
      }
      pinBtn.addEventListener('click', resolvePin);
      // Blur after pasting a link resolves it without being asked; an at:// URI
      // that is already correct is left alone.
      pin.addEventListener('change', function () {
        if (/^https?:/i.test(pin.value.trim())) resolvePin();
      });
      paintPin();
      // An h2 OUTSIDE the card, not block()'s label inside it. block() is the
      // filter-block scaffolding — a list of interchangeable rules that collapse
      // and carry a × — and its heading lives inside because it is part of that
      // chrome. Every section on Lab and Status is an h2 above a plain card, and
      // this one is a section, not a rule. It kept block() only because that is
      // what it was wearing on the Filters tab.
      pinHost.appendChild(h('h2', { text: 'Pinned post' }));
      pinHost.appendChild(h('div', { class: 'card pad' }, [
        h('div', { class: 'row wrapx' }, [pin, pinBtn, pinClear]), pinMsg,
        h('p', { class: 'small muted', text:
          'Paste the link straight from the app — the handle in it is resolved to ' +
          'a DID here, because the config stores at:// URIs. Served first on page ' +
          '1 with the Pinned badge. Whether it survives un-pinning depends on ' +
          'whether it matches this feed on its own.' }),
        h('p', { class: 'small muted', text:
          'This is the one control on this tab that changes the config — it is ' +
          'part of the same draft as the Filters tab and goes out with the same ' +
          'Save.' })]));

      // Three cards of read-once explanation used to sit between the exclude
      // patterns and the buttons that add one. They describe things this engine
      // does not offer a control for, so they are worth saying exactly once and
      // worth folding away afterwards.
      blocks.appendChild(block('Always applied — no setting for these', [
        h('p', { class: 'small muted', text:
          'Replies are removed. Every one of these feeds dropped them under ' +
          'SkyFeed and the ingest keeps doing it.' }),
        h('p', { class: 'small muted', text:
          'Reposts are a different collection and are never indexed, so there is ' +
          'nothing to remove.' }),
        h('p', { class: 'small muted', text:
          'Sort is indexedAt descending — stamped from the Jetstream event time, ' +
          'so a replayed post lands in its true position rather than on top.' })
      ], { fixed: true, collapsible: true, open: false }));
      showDirty();
    }

    // ── the feed RECORD: name, description, avatar — what readers see.
    //
    // These are not in filters.json at all; they live in the feed's record on
    // the PDS. Keeping them in a separate card with its own button is the
    // point: pressing Save below must never look like it might publish them,
    // and publishing must never look like it might change a filter.
    // Three maps, all keyed by rkey, and all of them OUTSIDE the DOM on purpose.
    // This card is rebuilt by every redraw(), and it used to be refilled from
    // the last PUBLISHED record each time — so a description typed here and not
    // yet published was silently reverted by any redraw, including one caused by
    // pressing an unrelated chip. Holding the state out here is the same
    // treatment jetstream/identity/totpEnrol already get in the status pane.
    //
    // Keying the pending avatar by rkey matters twice over: it was a single
    // variable, so choosing an image for one feed and then switching feeds left
    // it armed — and Publish would have written that image to the OTHER feed.
    var records = {};         // rkey -> the live record, once fetched
    var recordEdits = {};     // rkey -> {displayName, description} typed, unpublished
    var pendingAvatars = {};  // rkey -> {base64, name, note} chosen, unpublished

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
      // Pinned for the lifetime of THIS card. Reading the outer key from a
      // callback would ask which feed is open now, not which one this card was
      // built for — and those stop being the same the moment feeds are switched.
      var myKey = key;
      var card = h('div', { class: 'card pad block' }, []);
      var head = h('div', { class: 'bhead' }, [
        h('span', { class: 'blabel', text: 'Feed record — what readers see' })
      ]);
      var bodyEl = h('div', { class: 'bbody' }, [
        h('p', { class: 'small muted', text: 'Loading the published record…' })
      ]);
      card.appendChild(head);
      card.appendChild(bodyEl);

      var rec = records[myKey];
      if (rec) fill(bodyEl, rec);
      else {
        call('feed/' + encodeURIComponent(myKey) + '/record').then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          bodyEl.innerHTML = '';
          if (res.status !== 200) {
            bodyEl.appendChild(h('p', { class: 'small warn-text', text:
              'No published record for this rkey: ' + res.body.error }));
            return;
          }
          records[myKey] = res.body.record;
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
        // What is on screen is the unpublished edit if there is one, and the
        // published value otherwise — never the published value on top of an
        // edit that is still pending.
        var edit = recordEdits[myKey] || {};
        var pend = pendingAvatars[myKey];

        var name = h('input', { type: 'text', placeholder: 'display name' });
        name.value = edit.displayName !== undefined
          ? edit.displayName : (rec.displayName || '');
        var desc = h('textarea', { class: 'pat', spellcheck: 'false',
                                   placeholder: 'description shown on the feed page' });
        desc.value = edit.description !== undefined
          ? edit.description : (rec.description || '');
        function stash() {
          recordEdits[myKey] = { displayName: name.value, description: desc.value };
        }
        name.addEventListener('input', stash);
        desc.addEventListener('input', stash);

        var img = h('img', { class: 'avatar', alt: 'current avatar' });
        // A pending image must keep showing, or the preview and what Publish
        // would actually send disagree — which is worse than no preview.
        img.setAttribute('src', pend
          ? pend.base64
          : base + 'feed/' + encodeURIComponent(myKey) + '/avatar');
        var file = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
        var fileMsg = h('div', { class: 'small muted', text: pend ? pend.note : '' });
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          if (!f) { delete pendingAvatars[myKey]; fileMsg.textContent = ''; return; }
          var reader = new FileReader();
          reader.onload = function () {
            var note = f.name + ' — ' + Math.round(f.size / 1024) +
              ' KB, not published yet' +
              (f.size > 1000000 ? ' — OVER the 1 MB the lexicon allows' : '');
            pendingAvatars[myKey] = { base64: String(reader.result), name: f.name, note: note };
            img.setAttribute('src', String(reader.result));
            fileMsg.className = 'small muted';
            fileMsg.textContent = note;
          };
          reader.readAsDataURL(f);
        });

        var creds = credsRow();
        var btn = h('button', { class: 'outgoing', text: 'Publish to Bluesky' });
        var out = h('div', { class: 'msg', role: 'status' });
        btn.disabled = !writable;
        btn.addEventListener('click', function () {
          var payload = { handle: creds.handle.value, password: creds.pass.value };
          if (name.value !== (rec.displayName || '')) payload.displayName = name.value;
          if (desc.value !== (rec.description || '')) payload.description = desc.value;
          var avatar = pendingAvatars[myKey];
          if (avatar) payload.avatarBase64 = avatar.base64;
          if (payload.displayName === undefined && payload.description === undefined &&
              !payload.avatarBase64) {
            out.className = 'msg warn'; out.textContent = 'Nothing changed here yet.';
            return;
          }
          btn.disabled = true;
          out.className = 'msg'; out.textContent = 'Publishing…';
          call('feed/' + encodeURIComponent(myKey) + '/record', { body: payload })
            .then(function (r) {
              return r.json().then(function (b) { return { status: r.status, body: b }; });
            }).then(function (res) {
              btn.disabled = false;
              // The password is dropped the moment it has been used, here too.
              creds.pass.value = '';
              if (res.status !== 200) {
                out.className = 'msg bad'; out.textContent = res.body.error; return;
              }
              records[myKey] = { uri: res.body.uri, cid: res.body.cid,
                displayName: name.value, description: desc.value,
                avatarCid: rec.avatarCid };
              // Published, so these are no longer pending. Clearing them is what
              // stops the next redraw from restoring an edit that already landed.
              delete pendingAvatars[myKey];
              delete recordEdits[myKey];
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
      var out = h('div', { class: 'msg', role: 'status' });
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
          body.appendChild(h('p', { class: 'msg warn', role: 'status', text:
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
      var out = h('div', { class: 'msg', role: 'status' });
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

        // Built as nodes, not as one string, so the two things worth reading —
        // the word that let it in and the word that threw it out — can be the
        // two things that stand out. The old version printed the server's whole
        // reason line, whose useful half was a truncated copy of a forty-token
        // alternation: it named the rule that fired and not the token, which is
        // the only part anyone can act on.
        function targetWords(t) {
          return t === 'text' ? 'post text'
            : t === 'text|alt_text' ? 'text + alt text'
            : t === 'text|alt_text|link' ? 'text, alt text and links' : t;
        }
        function quoted(word, where) {
          var kids = [document.createTextNode(' ')];
          kids.push(h('code', { class: 'hit', text: '"' + word + '"' }));
          if (where) {
            kids.push(document.createTextNode(' in ' + targetWords(where)));
          }
          return kids;
        }
        // Returns an array of nodes for one feed's verdict.
        function reasonNodes(f) {
          var out = [];
          if (f.excludeMatch) {
            var line = h('p', { class: 'small' }, []);
            line.appendChild(document.createTextNode('Dropped on'));
            quoted(f.excludeMatch, f.excludeTarget).forEach(function (n) {
              line.appendChild(n);
            });
            // The comment is the identifier, because it is also what titles the
            // block in the editor — read it here, find it there. A pattern with
            // no comment has nothing else to be called, so it falls back to its
            // own expression rather than leaving you to guess which of ten it was.
            if (f.excludeComment) {
              line.appendChild(document.createTextNode(', by the rule '));
              line.appendChild(h('strong', { text: f.excludeComment }));
            } else if (f.excludePattern) {
              line.appendChild(document.createTextNode(', by the pattern '));
              line.appendChild(h('code', { class: 'mono small',
                                           text: '/' + f.excludePattern + '…/' }));
            }
            line.appendChild(document.createTextNode('.'));
            out.push(line);
            // How it got as far as the exclude gate. Either half alone is a
            // riddle; together they are the whole story.
            if (f.includeMatch) {
              var got = h('p', { class: 'small muted' }, []);
              got.appendChild(document.createTextNode('It had matched'));
              quoted(f.includeMatch, f.includeTarget).forEach(function (n) {
                got.appendChild(n);
              });
              got.appendChild(document.createTextNode(' on the way in.'));
              out.push(got);
            }
            return out;
          }
          if (!f.reason && f.includeMatch) {
            var ok = h('p', { class: 'small' }, []);
            ok.appendChild(document.createTextNode('Matched on'));
            quoted(f.includeMatch, f.includeTarget).forEach(function (n) {
              ok.appendChild(n);
            });
            ok.appendChild(document.createTextNode('.'));
            return [ok];
          }
          return [h('p', { class: 'small', text: f.reason || 'matches this feed' })];
        }
        // Still a plain string where a table cell needs one.
        function reasonOf(f) {
          if (f.excludeMatch) {
            return 'dropped on "' + f.excludeMatch + '"' +
              (f.excludeComment ? ' — ' + f.excludeComment : '');
          }
          return f.reason || (f.includeMatch
            ? 'matched "' + f.includeMatch + '" on ' + f.includeTarget
            : 'matches this feed');
        }
        function disagreement(f) {
          if (!f.disagrees) return null;
          return f.stored
            ? 'But it IS stored — the config changed after this post was seen. ' +
              'auto-purge sweeps that on its own 5-minute clock (:00, :05, ' +
              ':10 …); a filter edit does not trigger it.'
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
          var kids = [head].concat(reasonNodes(mine));
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
        var btn = h('button', { class: 'outgoing', text: 'Publish and add' });
        var out = h('div', { class: 'msg', role: 'status' });
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
      var stat = (s.feeds || []).filter(function (x) { return x.key === k; })[0];
      pickerNote.textContent = k + (stat ? ' — ' + stat.rows + ' posts stored' : '');
      draft = JSON.parse(JSON.stringify(full.feeds[k] || {}));
      pristine = JSON.stringify(draft);
      results.innerHTML = '';
      say('');
      redraw();
      // The record card lives on its own tab now, so it is rebuilt here rather
      // than by redraw(). Its unpublished state is keyed by rkey and held
      // outside the DOM, so this cannot lose an edit.
      recordHost.innerHTML = '';
      recordHost.appendChild(recordCard());
      showDirty();
      redrawWhy();
      // The activity card follows the picker like the other three feed-scoped
      // tabs. Repainted in place — the status pane it sits in is not rebuilt.
      activityFeed = k;
      paintActivity();
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
    hosts.filters.addEventListener('input', showDirty);
    hosts.filters.addEventListener('change', showDirty);
    // The pinned post moved to the Lab tab but still edits this draft, so its
    // card gets the same delegation. Scoped to the card, NOT to the whole Lab
    // panel: the probe and whyNot fields beside it are diagnostics, and typing
    // in one of those must not report the config as unsaved.
    pinHost.addEventListener('input', showDirty);
    pinHost.addEventListener('change', showDirty);

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
          // Name only. A <select> is as wide as its longest option, so rkeys
          // and post counts in here pushed the whole page off a phone screen —
          // and nobody picks a feed by its record key anyway. Both facts live
          // on the line underneath instead.
          feedSel.appendChild(h('option', { value: k,
            text: full.feeds[k].displayName || k }));
        });
        selectFeed(feedSel.value || Object.keys(full.feeds || {})[0]);
        // Silence on success. This used to report the digest it had loaded,
        // which was fine in a message area halfway down the page and is not in
        // a bar fixed to the bottom of the window: it never cleared, so it cost
        // a permanent row of a phone screen to say something the Status tab
        // already shows. A read-only box still says so — that one is news.
        say(writable ? '' : 'Loaded — this box is READ-ONLY, so Save is off.',
            writable ? '' : 'warn');
      }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    }

    btnReload.addEventListener('click', function () {
      if (isDirty() && !confirm('Discard unsaved changes to ' + key + '?')) return;
      load();
    });

    // Validate and Measure ask the same kind of question about the same draft,
    // and used to get answers of wildly different sizes: Measure a block of
    // stat tiles and a sample table, Validate one line in the message strip at
    // the bottom of the window. The error case is what made that wrong — a
    // refused pattern names the path it choked on, and a 6rem scrollable strip
    // is the worst place on the page to read one.
    function renderValidation(me) {
      results.innerHTML = '';
      results.appendChild(h('div', { class: 'grid' }, [
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: String(me.includePatterns) }),
          h('div', { class: 'lbl', text: 'keep patterns' })]),
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: String(me.excludePatterns) }),
          h('div', { class: 'lbl', text: 'remove patterns' })]),
        h('div', { class: 'card stat' }, [
          h('div', { class: 'big', text: String(me.includeDids) }),
          h('div', { class: 'lbl', text: 'author DIDs' })])
      ]));
      results.appendChild(h('p', { class: 'msg ok', role: 'status', text:
        'Valid — every pattern compiled. Nothing has been written: this builds ' +
        'the candidate config and throws it away. Save is what installs it.' }));
    }
    function renderRefused(err) {
      results.innerHTML = '';
      results.appendChild(h('div', { class: 'card pad' }, [
        h('div', { class: 'bhead' }, [
          h('span', { class: 'blabel', text: 'Config refused' })
        ]),
        h('pre', { class: 'cmd', text: String(err) }),
        h('p', { class: 'small muted', text:
          'The path before the colon is where to look. Nothing was written and ' +
          'the service is still running the config it already had.' })
      ]));
    }

    btnValidate.addEventListener('click', function () {
      // Same reason as Measure: the bar is reachable from every tab, the block
      // it writes into is on this one.
      showTab('filters');
      busy(true); results.innerHTML = ''; say('Validating…');
      call('filters/validate', { body: assembled() }).then(function (r) {
        return r.json().then(function (b) { return { status: r.status, body: b }; });
      }).then(function (res) {
        busy(false); say('');
        if (res.status !== 200) { renderRefused(res.body.error); return; }
        var me = res.body.feeds.filter(function (f) { return f.key === key; })[0] || {};
        renderValidation(me);
      }).catch(function (e) { busy(false); say('Network error: ' + e.message, 'bad'); });
    });

    btnMeasure.addEventListener('click', function () {
      // The bar is reachable from every tab, but the table it produces is on
      // this one. Rendering it where nobody is looking would be worse than the
      // scroll it replaced.
      showTab('filters');
      busy(true); btnMeasure.textContent = 'Measuring…'; results.innerHTML = '';
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

    // Named, so Cmd+S can reach it without synthesising a click.
    function saveNow() {
      // No confirm(). What it would ask is already on screen, itemised, in the
      // Unsaved changes card — and unlike the dialog it names what is actually
      // about to change. The write is backed up, digest-guarded and validated
      // before it lands; the auto-purge that follows has its own safety cap.
      busy(true); btnSave.textContent = 'Saving…'; say('Saving…');
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
    }
    btnSave.addEventListener('click', saveNow);

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
        results.appendChild(h('p', { class: 'msg bad', role: 'status', text:
          'This is over the auto-purge safety cap (25 posts or 5%). The cleanup ' +
          'would REFUSE to apply it and log the refusal instead, so the posts ' +
          'would sit in the feed until someone looks. On a small feed even one ' +
          'post can cross the 5% line — check the count, not just the colour.' }));
      }
      if (r.unretrievable) {
        results.appendChild(h('p', { class: 'msg warn', role: 'status', text:
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

    // Cmd/Ctrl+S. This is a config editor; the hand does it anyway, and without
    // this the browser answers by offering to save the HTML.
    if (document.addEventListener) {
      document.addEventListener('keydown', function (e) {
        if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;
        if (e.preventDefault) e.preventDefault();
        if (!btnSave.disabled && isDirty()) saveNow();
      });
    }
    // Closing the tab is the one exit that was silent. Reload and switching
    // feeds both ask; this did not, and the draft is the only copy.
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', function (e) {
        if (!isDirty()) return;
        e.preventDefault();
        e.returnValue = '';
        return '';
      });
    }

    load();
    return {
      isDirty: isDirty,
      // Used by the feed table on the Status tab. Switching still asks before
      // throwing a draft away — that is destructive and leaves no record.
      select: function (k) {
        if (k === key) return;
        if (isDirty() && !confirm('Discard unsaved changes to ' + key + '?')) return;
        feedSel.value = k;
        selectFeed(k);
      }
    };
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
          h('th', { text: 'Sampled' }), h('th', { text: 'Ingest source' })])]),
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


  // Enrolling a second factor, from the page. Only someone already signed in
  // reaches this, which is the whole reason it can exist as a button — setting
  // the FIRST factor this way would be an unprotected setup page.
  function renderTotp() {
    var box = h('div', { class: 'card pad' }, []);
    var out = h('div', { class: 'msg', role: 'status' });
    var body = h('div', {}, []);

    function refresh() {
      call('totp/status').then(function (r) { return r.json(); }).then(function (b) {
        draw(b);
      }).catch(function (e) {
        out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
      });
    }

    function draw(st) {
      body.innerHTML = '';
      // A setup in progress outranks whatever the status says: coming back from
      // the authenticator app must land you where you left off.
      if (totpEnrol) { enrol(totpEnrol); return; }
      var on = st.enabled;
      body.appendChild(h('div', { class: 'row wrapx' }, [
        h('span', { class: 'pill ' + (st.broken ? 'bad' : on ? 'ok' : 'idle'),
                    text: st.broken ? 'broken' : on ? 'two-factor ON' : 'two-factor off' }),
        h('span', { class: 'small muted', text: st.source === 'env'
          ? 'set in .env on this box'
          : on ? 'enrolled from this page' : 'password only' })
      ]));

      if (st.broken) {
        body.appendChild(h('p', { class: 'small warn-text', text:
          'The stored secret cannot be read, so logins are refused rather than ' +
          'quietly falling back to one factor. Delete ' + st.file + ' on the box.' }));
      }

      if (!st.managedHere) {
        body.appendChild(h('p', { class: 'small muted', text:
          'It came from .env, which this page cannot write. Change it there.' }));
        return;
      }

      if (!on) {
        var start = h('button', { class: 'primary', text: 'Set up two-factor' });
        start.addEventListener('click', function () {
          start.disabled = true;
          out.className = 'msg'; out.textContent = 'Generating…';
          call('totp/begin', { body: {} }).then(function (r) {
            return r.json().then(function (b) { return { status: r.status, body: b }; });
          }).then(function (res) {
            start.disabled = false;
            if (res.status !== 200) {
              out.className = 'msg bad'; out.textContent = res.body.error; return;
            }
            out.textContent = '';
            totpEnrol = res.body;
            enrol(totpEnrol);
          }).catch(function (e) {
            start.disabled = false;
            out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
          });
        });
        body.appendChild(h('div', { class: 'toolbar' }, [start]));
        return;
      }

      // Off requires both factors again: a hijacked session must not be able to
      // quietly remove the thing protecting the account.
      var pass = h('input', { class: 'grow', type: 'password',
                              autocomplete: 'current-password',
                              placeholder: 'your admin password' });
      // Short enough to fit the field. The placeholder is this input's only
      // label, so one that gets clipped to "current 6-di" is worse than none.
      var code = h('input', { class: 'code', type: 'text', inputmode: 'numeric',
                              maxlength: '6', placeholder: '6-digit code' });
      var off = h('button', { text: 'Turn two-factor off' });
      off.addEventListener('click', function () {
        if (!confirm('Turn off two-factor? The password alone will get in again.')) return;
        off.disabled = true;
        out.className = 'msg'; out.textContent = 'Checking…';
        call('totp/disable', { body: { password: pass.value, code: code.value } })
          .then(function (r) {
            return r.json().then(function (b) { return { status: r.status, body: b }; });
          }).then(function (res) {
            off.disabled = false; pass.value = ''; code.value = '';
            if (res.status !== 200) {
              out.className = 'msg bad'; out.textContent = res.body.error; return;
            }
            out.className = 'msg ok'; out.textContent = 'Two-factor is off.';
            refresh();
          }).catch(function (e) {
            off.disabled = false;
            out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
          });
      });
      body.appendChild(h('div', { class: 'row wrapx' }, [pass, code, off]));
    }

    function enrol(d) {
      body.innerHTML = '';
      body.appendChild(h('p', { class: 'small', text:
        'Scan this with your authenticator app, then enter the code it shows. ' +
        'Nothing is stored until that code checks out.' }));
      if (d.qr) {
        var img = h('img', { class: 'qr', alt: 'QR code for enrolment' });
        img.setAttribute('src', d.qr);
        body.appendChild(img);
      }
      body.appendChild(h('p', { class: 'small muted', text:
        'Cannot scan it? Enter the secret by hand:' }));
      body.appendChild(h('pre', { class: 'cmd', text: d.secret }));
      body.appendChild(h('p', { class: 'small muted', text:
        'Or paste this URI into the app:' }));
      body.appendChild(h('pre', { class: 'cmd', text: d.uri }));

      // Not the login form's field, which is stacked and should stay full
      // width — this one shares a row with two buttons.
      var code = h('input', { class: 'code', type: 'text', inputmode: 'numeric',
                              maxlength: '6', placeholder: '6-digit code' });
      var confirm2 = h('button', { class: 'primary', text: 'Confirm and enable' });
      var cancel = h('button', { text: 'Cancel' });
      cancel.addEventListener('click', function () { totpEnrol = null; refresh(); });
      confirm2.addEventListener('click', function () {
        confirm2.disabled = true;
        out.className = 'msg'; out.textContent = 'Checking the code…';
        call('totp/enable', { body: { code: code.value } }).then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        }).then(function (res) {
          confirm2.disabled = false;
          if (res.status !== 200) {
            out.className = 'msg bad'; out.textContent = res.body.error; return;
          }
          out.className = 'msg ok'; out.textContent = res.body.note;
          totpEnrol = null;
          refresh();
        }).catch(function (e) {
          confirm2.disabled = false;
          out.className = 'msg bad'; out.textContent = 'Network error: ' + e.message;
        });
      });
      body.appendChild(h('div', { class: 'row wrapx' }, [code, confirm2, cancel]));
      body.appendChild(h('p', { class: 'small muted', text:
        'Take your time — this page stops refreshing until you confirm or ' +
        'cancel, and the key above stays the same if you come back to it.' }));
      body.appendChild(h('p', { class: 'small muted', text:
        'Locked out later? Delete the file this page names under Security on ' +
        'the box, and the password alone works again — no restart needed.' }));
    }

    box.appendChild(body);
    box.appendChild(out);
    refresh();
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

  // NO AUTO-REFRESH, deliberately. Of everything on this page exactly one number
  // moves on a human timescale — how far behind the ingest cursor is — and a
  // measurement showed the feeds gaining a single post per thirty seconds. That
  // is not worth a redraw, and the redraw was not free: it rebuilt the editor
  // under whoever was typing, and folded away a half-finished 2FA enrolment
  // while its owner was in a password manager. Both were real bugs.
  //
  // What replaces it is honesty about age: the header says how old the reading
  // is and grows more insistent as it sits, so stale numbers cannot be mistaken
  // for live ones. That label updates its own text node and nothing else — no
  // rebuild, no lost focus, no lost state.
  var statusPane = null, editorPane = null, editor = null;
  var chromeEl = null, navEl = null, barEl = null, securityPane = null;
  var hosts = null;
  var loadedAt = 0;
  var stampEl = null;
  // Which tab is open, held out here so a Refresh — which rebuilds the status
  // and security panels — cannot drop the reader back on the first one.
  var activeTab = 'filters';
  var tabButtons = {}, tabPanels = {};
  // Answers to the two on-demand checks, and any half-finished 2FA enrolment.
  // Held out here because the status pane is rebuilt whenever it reloads, and
  // an answer that vanished mid-read would be worse than no answer.
  var jetstream = { readings: null, busy: false, chosen: null };
  var identity = { result: null, busy: false, error: null };
  var totpEnrol = null;
  // Same treatment for the activity card: the payload and which sweeps are
  // expanded outlive both a Refresh and a feed switch. activityHost is the one
  // node it owns, so a repaint touches that and never the pane around it.
  var activity = { data: null, error: null, open: {} };
  var activityHost = null, activityFeed = null, activityNames = {};

  function touchStamp() {
    if (!stampEl || !loadedAt) return;
    var age = Math.round((Date.now() - loadedAt) / 1000);
    stampEl.textContent = age < 45 ? 'just now' : 'as of ' + ago(age) + ' ago';
    stampEl.className = 'small ' + (age > 600 ? 'warn-text' : 'muted');
  }
  setInterval(touchStamp, 10000);

  // Five panels, one visible. The feed picker sits ABOVE them because three of
  // the five answer for one feed at a time, and asking which feed you meant is
  // not a per-tab question.
  var TABS = [
    ['filters', 'Filters'], ['lab', 'Lab'], ['record', 'Record'],
    ['status', 'Status'], ['security', 'Security']
  ];

  function showTab(id) {
    activeTab = id;
    TABS.forEach(function (t) {
      var on = t[0] === id;
      if (tabButtons[t[0]]) {
        tabButtons[t[0]].setAttribute('aria-selected', on ? 'true' : 'false');
        // Only the selected tab is a tab stop; arrows move between them, which
        // is what a tablist is supposed to do.
        tabButtons[t[0]].setAttribute('tabindex', on ? '0' : '-1');
      }
      if (tabPanels[t[0]]) tabPanels[t[0]].className = on ? '' : 'hidden';
    });
    paintBar();
  }

  // Shown whenever the filters are the subject — either because that tab is
  // open, or because there is unsaved work that must not be forgotten on the
  // way to another tab.
  function paintBar() {
    if (!barEl) return;
    var show = !!editor && (activeTab === 'filters' || editor.isDirty());
    barEl.className = 'actions' + (show ? '' : ' hidden');
    app.className = show ? 'hasbar' : '';
    // The CSS reserve is a starting guess and the bar is not a fixed height: it
    // wraps on a narrow screen and grows again when a message lands in it. A
    // guess that comes up short does not look like a layout bug, it looks like
    // the page is missing its last card — so measure the thing and reserve what
    // it actually takes. Guarded because there is no layout in the test stub.
    if (app.style && show && barEl.offsetHeight) {
      app.style.paddingBottom = (barEl.offsetHeight + 16) + 'px';
    } else if (app.style) {
      app.style.paddingBottom = '';
    }
  }

  function panes() {
    if (statusPane) return;
    app.innerHTML = '';
    chromeEl = h('div', {}, []);
    var pickerHost = h('div', {}, []);
    navEl = h('div', { class: 'tabs', role: 'tablist',
                       'aria-label': 'Admin sections' }, []);
    tabButtons = {}; tabPanels = {};
    app.appendChild(chromeEl);
    app.appendChild(pickerHost);
    app.appendChild(navEl);

    TABS.forEach(function (t, i) {
      var panel = h('div', { role: 'tabpanel', id: 'panel-' + t[0],
                             'aria-label': t[1] }, []);
      var btn = h('button', { role: 'tab', id: 'tab-' + t[0],
                              'aria-controls': 'panel-' + t[0], text: t[1] });
      btn.addEventListener('click', function () { showTab(t[0]); });
      btn.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        if (e.preventDefault) e.preventDefault();
        var next = TABS[(i + d + TABS.length) % TABS.length][0];
        showTab(next);
        if (tabButtons[next].focus) tabButtons[next].focus();
      });
      tabButtons[t[0]] = btn;
      tabPanels[t[0]] = panel;
      navEl.appendChild(btn);
      app.appendChild(panel);
    });

    statusPane = tabPanels.status;
    securityPane = tabPanels.security;
    editorPane = tabPanels.filters;
    barEl = h('div', { class: 'actions hidden' }, []);
    app.appendChild(barEl);
    hosts = { picker: pickerHost, filters: tabPanels.filters, lab: tabPanels.lab,
              record: tabPanels.record, actions: barEl };
    showTab(activeTab);
  }

  // Its own request, fired only once the status has come back. Folding it into
  // /api/status would put a directory listing and a JSON parse of whatever is
  // lying next to the database in the path of the page whose job is to report
  // that the service is healthy. Held data stays on screen while this is in
  // flight, so a Refresh never blanks the card it is refreshing.
  function loadActivity() {
    call('activity').then(function (r) {
      if (r.status === 401) return;
      return r.json().then(function (b) {
        if (b && b.ok) { activity.data = b.activity; activity.error = null; }
        else activity.error = (b && b.error) || 'unexpected reply';
        paintActivity();
      });
    }).catch(function (e) {
      activity.error = e.message;
      paintActivity();
    });
  }

  function load() {
    api('status').then(function (r) {
      // Handled already: call() routes every 401 through onUnauthorized, which
      // knows whether there is unsaved work to protect. Rendering the login form
      // from here as well is what used to throw an edit away on a Refresh.
      if (r.status === 401) return;
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json().then(function (b) {
        panes();
        loadedAt = Date.now();
        renderChrome(b.status, chromeEl);
        renderStatus(b.status, statusPane);
        securityPane.innerHTML = '';
        securityPane.appendChild(h('h2', { text: 'Security' }));
        securityPane.appendChild(renderTotp());
        // Built once. Its own Reload button is how it refetches.
        if (!editor) editor = renderConfigEditor(b.status, hosts);
        paintBar();
        touchStamp();
        loadActivity();
      });
    }).catch(function (e) {
      if (!statusPane) {
        app.innerHTML = '';
        app.appendChild(h('div', { class: 'card pad' }, [
          h('p', { class: 'err', text: 'Could not load status: ' + e.message })
        ]));
      }
    });
  }

  load();
})();
</script>
</body>
</html>
`
