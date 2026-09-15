'use strict';

/*
 * faf-web client.
 *
 * Plain script, no framework, no build step, loaded once. Everything it fetches
 * goes to this origin under /api/, and the server proxies onward, so there is no
 * CORS involved anywhere in here.
 *
 * Two deliberate constraints:
 *  - No inline event handlers. The server sends a CSP with script-src 'self',
 *    so onclick="" attributes would be blocked. Everything binds with
 *    addEventListener.
 *  - Rendering is defensive. The FAF API's exact attribute names could not be
 *    verified while this was written (the build sandbox has no route to
 *    api.faforever.com), so every field read goes through pick() with
 *    fallbacks, and a missing field degrades to a dash rather than "undefined".
 */

var view = document.getElementById('view');
var sidenav = document.getElementById('sidenav');
var scrim = document.getElementById('scrim');
var menuBtn = document.getElementById('menuBtn');

/* ------------------------------------------------------------------- utils */

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
  }
  (children || []).forEach(function (c) {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

/** First present value among several candidate keys. */
function pick(obj) {
  if (!obj) return undefined;
  for (var i = 1; i < arguments.length; i++) {
    var v = obj[arguments[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function dash(v) {
  return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function fmtDate(value) {
  if (!value) return '—';
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function api(path) {
  return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
    return r.json().then(function (body) {
      if (!r.ok) {
        var msg = (body && body.error) ? body.error : ('request failed with ' + r.status);
        throw new Error(msg);
      }
      return body;
    }).catch(function (err) {
      if (err instanceof SyntaxError) throw new Error('the server sent something that was not JSON');
      throw err;
    });
  });
}

/** Index a JSON:API "included" array so relationships can be resolved. */
function indexIncluded(doc) {
  var map = {};
  (doc && doc.included ? doc.included : []).forEach(function (r) {
    map[r.type + ':' + r.id] = r;
  });
  return map;
}

function related(resource, name, included) {
  var rel = resource && resource.relationships && resource.relationships[name];
  var data = rel && rel.data;
  if (!data) return null;
  var one = Array.isArray(data) ? data[0] : data;
  if (!one) return null;
  return included[one.type + ':' + one.id] || null;
}

function loading(what) {
  view.replaceChildren(el('div', { class: 'spinner', text: 'Loading ' + what + '…' }));
}

function failure(what, err) {
  view.replaceChildren(
    el('div', { class: 'notice error' }, [
      el('strong', { text: 'Could not load ' + what }),
      el('p', { text: err && err.message ? err.message : 'Unknown error' }),
      el('p', { text: 'This usually means the upstream FAF service is unreachable rather than anything wrong here.' })
    ])
  );
}

function header(title, subtitle) {
  return [el('h2', { text: title }), subtitle ? el('p', { class: 'sub', text: subtitle }) : null];
}

function embed(title, subtitle, url) {
  var head = header(title, subtitle);
  view.replaceChildren.apply(view, [
    head[0],
    head[1],
    el('div', { class: 'frame-wrap' }, [
      el('iframe', { src: url, title: title, loading: 'lazy', referrerpolicy: 'no-referrer' })
    ]),
    el('p', { class: 'sub' }, [
      'If the panel above stays blank, the site refuses to be embedded. ',
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open it directly' }),
      '.'
    ])
  ].filter(Boolean));
}

/* ------------------------------------------------------------------- views */

var views = {};

views.news = function () {
  embed('News', 'The FAF news hub.', 'https://www.faforever.com/newshub');
};

views.changelog = function () {
  embed('Changelog', 'Game patch notes published by FAF.', 'https://faforever.github.io/fa/changelog');
};

views.units = function () {
  embed('Unit database', 'Stats for every unit, from the community unit database.', 'https://faforever.github.io/etfreeman-db/');
};

views.chat = function () {
  view.replaceChildren.apply(view, header('Chat', 'Not available in this build.').concat([
    el('div', { class: 'notice' }, [
      el('strong', { text: 'Chat needs a login, and login is not wired up yet.' }),
      el('p', { text: 'FAF chat is IRC, reachable from a browser over wss://chat.faforever.com, so no extra server is needed for it. What is missing is authentication: signing in uses FAF’s OAuth, and the desktop client redirects to a loopback address that a browser cannot use.' }),
      el('p', { text: 'Before chat can work, FAF has to register a web redirect URI for this client. That is a request to FAF, not something this service can arrange.' })
    ]),
    el('div', { class: 'notice' }, [
      el('strong', { text: 'One thing to check when it is wired up' }),
      el('p', { text: 'IRC nicknames are unique per connection. If FAF’s IRC server does not have multi-client mode enabled, being in chat here may collide with being in chat on the desktop client.' })
    ])
  ]));
};

views.leaderboard = function () {
  loading('the leaderboard');
  var q = '/api/faf/leaderboardRating'
    + '?include=player'
    + '&filter=' + encodeURIComponent('leaderboard.technicalName=="global"')
    + '&sort=-rating&page%5Bsize%5D=50';

  api(q).then(function (doc) {
    var inc = indexIncluded(doc);
    var rows = (doc.data || []).map(function (r, i) {
      var a = r.attributes || {};
      var player = related(r, 'player', inc);
      var name = player && player.attributes ? pick(player.attributes, 'login', 'displayName', 'userName') : undefined;
      var rating = pick(a, 'rating', 'meanRating');
      return el('tr', {}, [
        el('td', { class: 'rank num', text: String(i + 1) }),
        el('td', { text: dash(name) }),
        el('td', { class: 'num', text: rating === undefined ? '—' : String(Math.round(rating)) }),
        el('td', { class: 'num', text: dash(pick(a, 'totalGames', 'numGames')) })
      ]);
    });

    view.replaceChildren.apply(view, header('Leaderboard', 'Global rating, top 50.').concat([
      rows.length
        ? el('div', { class: 'table-wrap' }, [
            el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { class: 'num', text: '#' }),
                el('th', { text: 'Player' }),
                el('th', { class: 'num', text: 'Rating' }),
                el('th', { class: 'num', text: 'Games' })
              ])]),
              el('tbody', {}, rows)
            ])
          ])
        : el('div', { class: 'notice' }, [el('strong', { text: 'No ratings came back.' })])
    ]));
  }).catch(function (e) { failure('the leaderboard', e); });
};

function vaultView(kind, title, subtitle) {
  return function () {
    loading(title.toLowerCase());
    var q = '/api/faf/' + kind + '?include=latestVersion&sort=-updateTime&page%5Bsize%5D=40';

    api(q).then(function (doc) {
      var inc = indexIncluded(doc);
      var tiles = (doc.data || []).map(function (r) {
        var a = r.attributes || {};
        var v = related(r, 'latestVersion', inc);
        var va = (v && v.attributes) || {};
        var thumb = pick(va, 'thumbnailUrlSmall', 'thumbnailUrl', 'thumbnailUrlLarge');
        var name = pick(a, 'displayName', 'name');
        var author = pick(a, 'author', 'uploader');

        var detailBits = [];
        if (kind === 'map') {
          var players = pick(va, 'maxPlayers');
          var w = pick(va, 'width'), h = pick(va, 'height');
          if (players) detailBits.push(players + 'p');
          if (w && h) detailBits.push(Math.round(w / 51.2) + 'km');
        }
        if (author) detailBits.push(author);

        return el('div', { class: 'tile' }, [
          thumb ? el('img', { src: thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'meta' }, []),
          el('div', { class: 'meta' }, [
            el('div', { class: 'name', title: dash(name), text: dash(name) }),
            el('div', { class: 'detail', text: detailBits.join(' · ') || '—' })
          ])
        ]);
      });

      view.replaceChildren.apply(view, header(title, subtitle).concat([
        el('div', { class: 'notice' }, [
          el('strong', { text: 'Browsing only.' }),
          el('p', { text: 'A browser cannot install ' + title.toLowerCase() + ' into your game folder. Use the desktop client for that.' })
        ]),
        tiles.length
          ? el('div', { class: 'grid' }, tiles)
          : el('div', { class: 'notice' }, [el('strong', { text: 'Nothing came back.' })])
      ]));
    }).catch(function (e) { failure(title.toLowerCase(), e); });
  };
}

views.maps = vaultView('map', 'Maps', 'Most recently updated maps in the vault.');
views.mods = vaultView('mod', 'Mods', 'Most recently updated mods in the vault.');

views.tournaments = function () {
  loading('tournaments');
  api('/api/tourney/tournaments').then(function (list) {
    // This endpoint returns a bare array, not a wrapped object.
    var items = Array.isArray(list) ? list : (list && list.tournaments) || [];

    var cards = items.map(function (t) {
      var status = pick(t, 'status') || 'unknown';
      var isLive = status === 'running' || status === 'live';
      return el('article', { class: 'card' }, [
        el('div', { class: 'row-between' }, [
          el('strong', { text: dash(pick(t, 'name', 'title')) }),
          el('span', { class: 'pill' + (isLive ? ' live' : ''), text: String(status) })
        ]),
        el('p', { class: 'sub', text: [
          pick(t, 'format', 'type') || null,
          pick(t, 'eventDate') ? fmtDate(t.eventDate) : null
        ].filter(Boolean).join(' · ') || '—' }),
        t.id ? el('a', {
          class: 'btn',
          href: 'https://tournaments.doodlepros.com/t/' + encodeURIComponent(t.id),
          target: '_blank', rel: 'noopener noreferrer', text: 'Open'
        }) : null
      ]);
    });

    view.replaceChildren.apply(view, header('Tournaments', 'From tournaments.doodlepros.com.').concat([
      cards.length ? el('div', {}, cards)
        : el('div', { class: 'notice' }, [el('strong', { text: 'No tournaments listed right now.' })])
    ]));
  }).catch(function (e) { failure('tournaments', e); });
};

views.events = function () {
  loading('the events calendar');
  api('/api/events/calendar.json').then(function (doc) {
    var items = Array.isArray(doc) ? doc : (doc.events || doc.entries || []);
    var cards = items.map(function (ev) {
      var url = pick(ev, 'url', 'link');
      return el('article', { class: 'card' }, [
        el('div', { class: 'row-between' }, [
          el('strong', { text: dash(pick(ev, 'title', 'name')) }),
          el('span', { class: 'pill', text: fmtDate(pick(ev, 'startsAt', 'starts_at', 'start', 'date')) })
        ]),
        pick(ev, 'description', 'summary')
          ? el('p', { class: 'sub', text: pick(ev, 'description', 'summary') })
          : null,
        url ? el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Details' }) : null
      ]);
    });

    view.replaceChildren.apply(view, header('Events', 'Community events calendar.').concat([
      cards.length ? el('div', {}, cards)
        : el('div', { class: 'notice' }, [el('strong', { text: 'The calendar is empty.' })])
    ]));
  }).catch(function (e) { failure('the events calendar', e); });
};

views.training = function () {
  var links = [
    ['FAF Wiki', 'https://wiki.faforever.com/'],
    ['Game guides on the forum', 'https://forum.faforever.com/'],
    ['Replay archive', 'https://replay.faforever.com/']
  ];
  view.replaceChildren.apply(view, header('Training', 'Where to learn.').concat([
    el('div', { class: 'notice' }, [
      el('strong', { text: 'Placeholder, and honest about it.' }),
      el('p', { text: 'The desktop client’s training tab is built on a guides repository, recorded build orders and replay analysis. None of that has a web equivalent yet, so this is a link list until the client team says what the web version should contain.' })
    ]),
    el('div', { class: 'card list-links' }, links.map(function (l) {
      return el('a', { href: l[1], target: '_blank', rel: 'noopener noreferrer', text: l[0] });
    }))
  ]));
};

views.home = function () {
  var tiles = [
    ['News', '/news'], ['Tournaments', '/tournaments'], ['Events', '/events'],
    ['Leaderboard', '/leaderboard'], ['Maps', '/maps'], ['Mods', '/mods'],
    ['Unit DB', '/units'], ['Training', '/training'], ['Changelog', '/changelog']
  ];
  view.replaceChildren.apply(view, header('FAF Web', 'A companion for Forged Alliance Forever.').concat([
    el('div', { class: 'notice' }, [
      el('strong', { text: 'There is no Play tab in this build.' }),
      el('p', { text: 'Joining and hosting games needs a machine proof that a browser cannot produce. That part is waiting on a change to FAF’s server so lobby information is available through an API. Everything else here works without it.' })
    ]),
    el('div', { class: 'grid' }, tiles.map(function (t) {
      return el('a', { class: 'tile', href: t[1], 'data-link': '1' }, [
        el('div', { class: 'meta' }, [el('div', { class: 'name', text: t[0] })])
      ]);
    }))
  ]));
};

/* ------------------------------------------------------------------ router */

var ROUTES = {
  '/': 'home',
  '/news': 'news',
  '/chat': 'chat',
  '/maps': 'maps',
  '/mods': 'mods',
  '/leaderboard': 'leaderboard',
  '/tournaments': 'tournaments',
  '/events': 'events',
  '/training': 'training',
  '/changelog': 'changelog',
  '/units': 'units'
};

function currentRouteName() {
  var p = location.pathname.replace(/\/+$/, '') || '/';
  return ROUTES[p] || null;
}

function markActive(name) {
  var links = document.querySelectorAll('[data-route]');
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute('data-route') === name) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}

function render() {
  var name = currentRouteName();
  closeMenu();

  if (!name) {
    view.replaceChildren.apply(view, header('Not found', location.pathname).concat([
      el('p', {}, [el('a', { href: '/', 'data-link': '1', text: 'Go to the start page' })])
    ]));
    markActive(null);
    return;
  }

  markActive(name);
  try {
    views[name]();
  } catch (err) {
    failure('this page', err);
  }
  view.focus();
}

function navigate(pathname) {
  if (location.pathname === pathname) return;
  history.pushState({}, '', pathname);
  render();
}

document.addEventListener('click', function (e) {
  var a = e.target.closest ? e.target.closest('a') : null;
  if (!a) return;
  var href = a.getAttribute('href') || '';
  // Only intercept our own in-app links. External links, new tabs and
  // modified clicks behave normally.
  if (a.target === '_blank') return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  if (!href.startsWith('/') || href.startsWith('//')) return;
  var path = href.replace(/\/+$/, '') || '/';
  if (!ROUTES[path]) return;
  e.preventDefault();
  navigate(path);
});

window.addEventListener('popstate', render);

/* -------------------------------------------------------------------- menu */

function openMenu() {
  sidenav.classList.add('open');
  scrim.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  sidenav.classList.remove('open');
  scrim.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

menuBtn.addEventListener('click', function () {
  if (sidenav.classList.contains('open')) closeMenu(); else openMenu();
});
scrim.addEventListener('click', closeMenu);
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeMenu();
});

render();
