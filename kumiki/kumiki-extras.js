/* KUMIKI 共通：締切の帯の出し入れ・今月の残り枠・注文/Instagram DM のクリック計測 */
(function () {
  var html = document.documentElement;
  var lang = (html.getAttribute('lang') || 'ja').slice(0, 2);

  // 帯：少しスクロールしたら畳み、上に戻ったら出す
  if (html.classList.contains('kmk-band')) {
    var onScroll = function () {
      html.classList.toggle('kmk-band-off', window.scrollY > 80);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // クリック計測（gtag が無ければ何もしない）
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || typeof window.gtag !== 'function') return;
    var href = a.getAttribute('href');
    if (href.indexOf('shop-kumiki.fomus.jp') !== -1) {
      var m = href.match(/\/shop\/([^/?#]+)/);
      window.gtag('event', 'kumiki_order_click', { item_id: m ? m[1] : '', page_lang: lang });
    } else if (href.indexOf('ig.me/m/kumiki.jp') !== -1) {
      window.gtag('event', 'kumiki_instagram_dm_click', { page_lang: lang });
    }
  });

  // 今月の残り枠：取得できた本物の数字だけを出す。失敗・3秒超・不正値なら何も出さない
  var slots = document.querySelectorAll('.kmk-slots');
  if (!slots.length || !window.fetch) return;
  var text = {
    ja: function (r) { return r > 0 ? '今月の残り枠　<strong>' + r + '点</strong>' : '今月の制作枠は埋まりました。来月分のご予約を承ります。'; },
    en: function (r) { return r > 0 ? '<strong>' + r + (r === 1 ? ' piece' : ' pieces') + '</strong> left this month' : 'This month’s pieces are spoken for. We are now taking orders for next month.'; },
    fr: function (r) { return r > 0 ? 'Plus que <strong>' + r + (r === 1 ? ' pièce' : ' pièces') + '</strong> ce mois-ci' : 'Les pièces de ce mois sont toutes réservées. Commandes ouvertes pour le mois prochain.'; }
  };
  var ctrl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 3000);
  fetch('https://shop-kumiki.fomus.jp/api/kumiki/availability', ctrl ? { signal: ctrl.signal } : {})
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (d) {
      clearTimeout(timer);
      if (!d) return;
      var r = d.remaining, limit = d.limit;
      if (typeof r !== 'number' || r % 1 !== 0 || r < 0) return;
      if (typeof limit === 'number' && r > limit) return;
      var t = (text[lang] || text.en)(r);
      slots.forEach(function (el) { el.innerHTML = t; el.hidden = false; });
    })
    .catch(function () { clearTimeout(timer); });
})();
