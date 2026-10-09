/*
 * fomus.jp の計測（全ページ共通）。
 * - GA4 を読み込む（KUKUのページなど、すでに gtag がある場合は設定だけ足す）
 * - どこから来て何を見たか（初回・今回の入口と参照元、訪問回数、見たページの流れ）を
 *   訪問者のブラウザに90日だけ保持し、問い合わせフォーム（Web3Forms）の送信内容に添える
 * - 問い合わせ手前の行動（相談ボタン・メール/電話・フォーム入力開始・送信）を GA4 に送る
 */
(function () {
  var GA_ID = 'G-XXXXXXXXXX'
  var STORAGE_KEY = 'fomus-attribution'
  var SESSION_KEY = 'fomus-attribution-session'
  var RETENTION_MS = 90 * 24 * 60 * 60 * 1000
  var MAX_PAGES = 30

  // ---------- GA4 ----------
  window.dataLayer = window.dataLayer || []
  if (typeof window.gtag !== 'function') {
    window.gtag = function () { window.dataLayer.push(arguments) }
    window.gtag('js', new Date())
  }
  if (/^G-[A-Z0-9]+$/.test(GA_ID) && GA_ID !== 'G-XXXXXXXXXX') {
    if (!document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
      var tag = document.createElement('script')
      tag.async = true
      tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID
      document.head.appendChild(tag)
    }
    window.gtag('config', GA_ID)
  }
  function send(name, params) {
    try { window.gtag('event', name, Object.assign({ send_to: GA_ID }, params)) } catch (e) {}
  }

  // ---------- 流入経路 ----------
  var AI_SOURCES = [
    ['ChatGPT', /chatgpt\.com|chat\.openai\.com|openai/],
    ['Perplexity', /perplexity/],
    ['Gemini', /gemini\.google|bard\.google/],
    ['Copilot', /copilot\.microsoft|copilot\.cloud\.microsoft|edgeservices\.bing/],
    ['Claude', /claude\.ai|anthropic/],
    ['Grok', /grok\.com/],
    ['DeepSeek', /deepseek/],
    ['Genspark', /genspark/],
    ['Felo', /felo\.ai/],
  ]
  function detectAi() {
    for (var i = 0; i < arguments.length; i++) {
      var v = String(arguments[i] || '').toLowerCase()
      for (var j = 0; j < AI_SOURCES.length; j++) if (AI_SOURCES[j][1].test(v)) return AI_SOURCES[j][0]
    }
    return ''
  }
  function touch() {
    var ref = document.referrer || ''
    var params = new URLSearchParams(location.search)
    return {
      landingPage: location.pathname + location.search,
      referrer: ref.indexOf(location.origin) === 0 ? '' : ref,
      utmSource: params.get('utm_source') || '',
      at: new Date().toISOString(),
    }
  }
  function load() {
    var raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    var stored = JSON.parse(raw)
    if (Date.now() - new Date(stored.first.at).getTime() > RETENTION_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return stored
  }
  try {
    var stored = load()
    if (!sessionStorage.getItem(SESSION_KEY)) {
      sessionStorage.setItem(SESSION_KEY, '1')
      var t = touch()
      stored = stored
        ? Object.assign(stored, { last: t, visitCount: stored.visitCount + 1 })
        : { first: t, last: t, visitCount: 1, pages: [] }
    }
    if (stored) {
      stored.pages.push({ path: location.pathname, at: new Date().toISOString(), visit: stored.visitCount })
      stored.pages = stored.pages.slice(-MAX_PAGES)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    }
  } catch (e) {}

  function jst(iso) {
    return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function describe(ref) {
    if (!ref) return '直接 / 不明'
    try { return new URL(ref).hostname.replace(/^www\./, '') } catch (e) { return ref }
  }
  /** フォームに添える「経路」の項目 */
  function routeFields() {
    var s
    try { s = load() } catch (e) { s = null }
    if (!s) return {}
    var days = Math.floor((Date.now() - new Date(s.first.at).getTime()) / 86400000)
    var lastVisit = 0
    var trail = s.pages.map(function (p) {
      var head = p.visit !== lastVisit ? '【' + p.visit + '回目】' : ''
      lastVisit = p.visit
      return head + jst(p.at) + ' ' + p.path
    }).join('\n')
    return {
      '経路_AI経由': detectAi(s.first.referrer, s.first.utmSource, s.first.landingPage, s.last.referrer, s.last.landingPage) || 'なし',
      '経路_初回の参照元': describe(s.first.referrer),
      '経路_初回の入口': s.first.landingPage,
      '経路_初回訪問': jst(s.first.at) + '（問い合わせまで' + (days < 1 ? '当日' : days + '日') + '）',
      '経路_訪問回数': s.visitCount + '回目',
      '経路_今回の参照元': describe(s.last.referrer),
      '経路_今回の入口': s.last.landingPage,
      '経路_送信ページ': location.pathname,
      '経路_端末': screen.width + 'x' + screen.height + ' / ' + (navigator.language || ''),
      '経路_見たページ': trail,
    }
  }

  // ---------- 問い合わせ手前の行動 ----------
  var CTA = /(^|\/)contact(-en|-fr)?\.html|#contact/
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null
    if (!a) return
    var href = a.getAttribute('href') || ''
    var text = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (/^(mailto:|tel:)|line\.me|lin\.ee|wa\.me/.test(href)) {
      send('contact_click', { link_text: text, link_url: href.replace(/^mailto:([^?]+).*/, 'mailto:$1') })
    } else if (CTA.test(href)) {
      send('cta_click', { link_text: text, link_url: href })
    }
  }, true)

  var started = {}
  document.addEventListener('focusin', function (e) {
    var f = e.target && e.target.closest ? e.target.closest('form') : null
    if (!f || started[location.pathname]) return
    started[location.pathname] = true
    send('inquiry_form_start', { form_id: location.pathname })
  })

  // Web3Forms のフォーム：送信の直前に経路の項目を隠し欄として足す（各ページの送信処理より先に動く）
  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form || !/web3forms/.test(form.getAttribute('action') || '')) return
    var fields = routeFields()
    Object.keys(fields).forEach(function (name) {
      var input = form.querySelector('input[data-route="' + name + '"]')
      if (!input) {
        input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.setAttribute('data-route', name)
        form.appendChild(input)
      }
      input.value = fields[name]
    })
  }, true)

  // 送信が成功したら GA4 に「問い合わせ」として送る
  var originalFetch = window.fetch
  if (originalFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      var p = originalFetch.apply(this, arguments)
      if (/api\.web3forms\.com/.test(url)) {
        p.then(function (res) {
          if (res.ok) send('generate_lead', { form_type: 'web3forms', submitted_from: location.pathname })
        }).catch(function () {})
      }
      return p
    }
  }
})()
