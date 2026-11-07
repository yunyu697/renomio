/* 静态设计稿交互：仅用于演示主题与控件状态，不涉及业务逻辑 */
(function () {
  var KEY = 'renomio-design-theme';

  function getStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? '切换到明色主题' : '切换到暗色主题');
    }
  }

  var stored = getStored();
  if (!stored) {
    stored = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  setTheme(stored);

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-theme-toggle]');
    if (toggle) {
      var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      setTheme(current === 'dark' ? 'light' : 'dark');
      return;
    }

    var sw = e.target.closest('.switch');
    if (sw) {
      sw.classList.toggle('on');
      var card = sw.closest('.rule-card');
      if (card) card.classList.toggle('on', sw.classList.contains('on'));
      return;
    }

    var cb = e.target.closest('.checkbox');
    if (cb && !cb.classList.contains('partial')) {
      cb.classList.toggle('on');
      var row = cb.closest('.trow');
      if (row) row.classList.toggle('selected', cb.classList.contains('on'));
      return;
    }

    var tab = e.target.closest('.tab, .subtab');
    if (tab && tab.dataset.switchable !== 'false') {
      var scope = tab.parentElement;
      Array.prototype.forEach.call(scope.querySelectorAll('.tab, .subtab'), function (t) {
        t.classList.remove('active', 'on');
      });
      tab.classList.add(tab.classList.contains('subtab') ? 'on' : 'active');
      return;
    }

    var ruleHead = e.target.closest('.rule-head');
    if (ruleHead) {
      var card = ruleHead.closest('.rule-card');
      if (card) card.classList.toggle('open');
    }
  });
})();
