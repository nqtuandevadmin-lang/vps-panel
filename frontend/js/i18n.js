/* i18n.js - Vietnamese / English. Default: browser language, saved choice wins. */
'use strict';
(function () {
  const DICT = {
    vi: {
      'nav.dashboard': 'Bảng điều khiển',
      'nav.nodes': 'Máy chủ VPS',
      'nav.terminal': 'Terminal',
      'nav.files': 'Tệp tin',
      'nav.processes': 'Tiến trình',
      'nav.services': 'Dịch vụ',
      'nav.network': 'Mạng',
      'nav.disks': 'Ổ đĩa',
      'nav.invites': 'Link kết nối',
      'nav.users': 'Tài khoản panel',
      'nav.logs': 'Nhật ký',
      'nav.backups': 'Sao lưu',
      'nav.settings': 'Cài đặt',
      'nav.about': 'Giới thiệu',
      'auth.signin': 'Đăng nhập',
      'auth.signup': 'Đăng ký',
      'auth.tagline': 'Quản lý VPS của bạn',
      'auth.heroTitle': 'Máy chủ của bạn.\nMột đường dẫn.',
      'auth.heroSub': 'Kết nối VPS của bạn bằng một dòng lệnh, rồi điều khiển terminal, tệp tin, dịch vụ từ trình duyệt.',
      'auth.username': 'Tên đăng nhập',
      'auth.password': 'Mật khẩu',
      'auth.email': 'Email',
      'auth.twofa': 'Mã 2FA',
      'auth.signinBtn': 'Đăng nhập',
      'auth.signupBtn': 'Tạo tài khoản',
      'auth.noAccount': 'Chưa có tài khoản?',
      'auth.hasAccount': 'Đã có tài khoản?',
      'auth.createOne': 'Đăng ký ngay',
      'auth.signinNow': 'Đăng nhập',
      'auth.hint': 'Ít nhất 12 ký tự, có chữ hoa, chữ thường, số và ký hiệu.',
      'auth.strength': { 0: 'Quá ngắn', 1: 'Yếu', 2: 'Khá', 3: 'Tốt', 4: 'Mạnh', 5: 'Rất mạnh' },
      'auth.inviteOk': 'Đã nhận lời mời',
      'auth.inviteUsed': 'Lời mời đã dùng',
      'auth.accounts': 'tài khoản',
      'nodes.title': 'Máy chủ đã kết nối',
      'nodes.sub': 'Kết nối VPS của bạn để mở terminal và quản lý tệp tin.',
      'nodes.newLink': 'Tạo link kết nối',
      'nodes.empty': 'Chưa có máy chủ nào',
      'nodes.emptySub': 'Bấm "Tạo link kết nối", sau đó chạy lệnh curl trên VPS của bạn.',
      'nodes.online': 'Đang kết nối',
      'nodes.offline': 'Mất kết nối',
      'nodes.expires': 'Hết hạn sau',
      'nodes.minutes': 'phút',
      'nodes.runThis': 'Chạy lệnh này trên VPS của bạn (hết hạn sau 10 phút)',
      'nodes.copy': 'Sao chép',
      'nodes.copied': 'Đã sao chép',
      'nodes.terminal': 'Mở terminal',
      'nodes.remove': 'Gỡ bỏ',
      'nodes.connecting': 'Đang kết nối tới máy chủ...',
      'nodes.noNode': 'Chưa có VPS nào kết nối',
      'term.title': 'Terminal',
      'term.pickNode': 'Chọn máy chủ để mở terminal',
      'term.newSession': 'Phiên mới',
      'term.reconnect': 'Kết nối lại',
      'term.kill': 'Kết thúc',
      'common.save': 'Lưu', 'common.cancel': 'Huỷ', 'common.refresh': 'Tải lại',
      'common.close': 'Đóng', 'common.delete': 'Xoá', 'common.copy': 'Sao chép',
      'lang': 'Ngôn ngữ',
    },
    en: {
      'nav.dashboard': 'Dashboard',
      'nav.nodes': 'VPS Servers',
      'nav.terminal': 'Terminal',
      'nav.files': 'Files',
      'nav.processes': 'Processes',
      'nav.services': 'Services',
      'nav.network': 'Network',
      'nav.disks': 'Disks',
      'nav.invites': 'Connect Links',
      'nav.users': 'Panel Users',
      'nav.logs': 'Logs',
      'nav.backups': 'Backups',
      'nav.settings': 'Settings',
      'nav.about': 'About',
      'auth.signin': 'Sign in',
      'auth.signup': 'Create account',
      'auth.tagline': 'Manage your own VPS',
      'auth.heroTitle': 'Your server.\nOne link away.',
      'auth.heroSub': 'Connect your VPS with one command, then control the terminal, files and services from the browser.',
      'auth.username': 'Username',
      'auth.password': 'Password',
      'auth.email': 'Email',
      'auth.twofa': '2FA code',
      'auth.signinBtn': 'Sign in',
      'auth.signupBtn': 'Create my account',
      'auth.noAccount': 'No account yet?',
      'auth.hasAccount': 'Already registered?',
      'auth.createOne': 'Create one',
      'auth.signinNow': 'Sign in',
      'auth.hint': 'At least 12 characters, upper + lower + digit + symbol.',
      'auth.strength': { 0: 'Too short', 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong', 5: 'Very strong' },
      'auth.inviteOk': 'Invite accepted',
      'auth.inviteUsed': 'Invite used',
      'auth.accounts': 'accounts',
      'nodes.title': 'Connected servers',
      'nodes.sub': 'Connect your VPS to open a terminal and manage files.',
      'nodes.newLink': 'Create connect link',
      'nodes.empty': 'No servers connected',
      'nodes.emptySub': 'Click "Create connect link", then run the curl command on your VPS.',
      'nodes.online': 'Online',
      'nodes.offline': 'Offline',
      'nodes.expires': 'Expires in',
      'nodes.minutes': 'minutes',
      'nodes.runThis': 'Run this on your VPS (expires in 10 minutes)',
      'nodes.copy': 'Copy',
      'nodes.copied': 'Copied',
      'nodes.terminal': 'Open terminal',
      'nodes.remove': 'Remove',
      'nodes.connecting': 'Connecting to the server...',
      'nodes.noNode': 'No VPS connected yet',
      'term.title': 'Terminal',
      'term.pickNode': 'Choose a server to open a terminal',
      'term.newSession': 'New session',
      'term.reconnect': 'Reconnect',
      'term.kill': 'Kill',
      'common.save': 'Save', 'common.cancel': 'Cancel', 'common.refresh': 'Refresh',
      'common.close': 'Close', 'common.delete': 'Delete', 'common.copy': 'Copy',
      'lang': 'Language',
    },
  };

  let lang = localStorage.getItem('panel_lang');
  if (!lang) lang = (navigator.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';

  function t(key) {
    const dict = DICT[lang] || DICT.en;
    return dict[key] ?? DICT.en[key] ?? key;
  }

  window.i18n = {
    t,
    get lang() { return lang; },
    set(l) { if (DICT[l]) { lang = l; localStorage.setItem('panel_lang', l); apply(); } },
    toggle() { this.set(lang === 'vi' ? 'en' : 'vi'); },
    // replace text of every [data-i18n] element
    apply() {
      document.documentElement.lang = lang;
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const k = el.dataset.i18n;
        const v = t(k);
        if (typeof v === 'object') return;
        if (el.dataset.i18nHtml || v.includes('\n')) el.innerHTML = v.replace(/\n/g, '<br>');
        else el.textContent = v;
      });
      document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
        el.placeholder = t(el.dataset.i18nPh);
      });
    },
  };

  // language toggle button in the topbar
  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('lang-toggle');
    const sync = () => { if (btn) { btn.textContent = lang.toUpperCase(); btn.title = `${t('lang')}: ${lang === 'vi' ? 'English' : 'Tiếng Việt'}`; } };
    if (btn) btn.onclick = () => { window.i18n.toggle(); sync(); };
    sync();
    window.i18n.apply();
  });
})();