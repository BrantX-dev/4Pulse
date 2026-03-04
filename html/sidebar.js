/* ═══════════════════════════════════════════════════════════
   sidebar.js  —  4Pulse Sidebar
   Базируется на popup.js + override для sidebar-окружения:
   1. Никогда не закрывает окно
   2. adjustPopupHeight отключён (CSS управляет высотой)
   3. Polling работает независимо от close_on_open
   4. Счётчики видны в шапке sidebar
   ═══════════════════════════════════════════════════════════ */

// ── Константы (идентично popup.js) ─────────────────────────
const CLASS_HIDDEN = 'hidden';
const CLASS_ACTIVE = 'active';
const CLASS_READ   = 'read';
const CLASS_UNREAD = 'unread';
const CLASS_PINNED = 'pinned';

// ── Состояние ───────────────────────────────────────────────
let elements    = {};
let settings    = {
    simple_list:       false,
    close_on_open:     false,   // ← sidebar НИКОГДА не закрывается
    default_view:      'collapsed',
    show_all_favorites: false,
    show_all_qms:       false,
    show_all_mentions:  false,
    bw_icons:          false,
    accent_color:      'blue',
    compact_mode:      false,
};
let currentData   = null;
let currentFilter = null;
let pollInterval  = null;

// ── Sidebar: polling каждые 30 секунд (активно всегда) ──────
const SIDEBAR_POLL_MS = 30_000;

// ── Инициализация ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        setupRealtimeUpdates();
        initializeClock();
        await applyThemeAndColors();
        await initializeSidebar();
        await applyFontSettings();
    } catch (err) {
        console.error('Sidebar init error:', err);
    }
});

function showErrorState(msg) {
    document.body.innerHTML = `<div style="padding:20px;color:#ff6b6b;text-align:center">
        <b>Ошибка загрузки</b><br>${msg}
        <br><button onclick="location.reload()" style="margin-top:10px;padding:6px 14px;cursor:pointer">Перезагрузить</button>
    </div>`;
}

// ── Real-time updates (push от background) ──────────────────
function setupRealtimeUpdates() {
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'counts_updated' && msg.counts) {
            const prevQms  = currentData?.qms?.count       || 0;
            const prevFav  = currentData?.favorites?.count || 0;
            const prevMen  = currentData?.mentions?.count  || 0;
            updateCountersFromCounts(msg.counts);
            // FIX Bug 3: если счётчик вырос — обновляем списки тоже, иначе
            // тогл будет показывать пустой список (данные устарели)
            const newItems = msg.counts.qms > prevQms
                          || msg.counts.favorites > prevFav
                          || msg.counts.mentions > prevMen;
            if (newItems) {
                refreshListsFromBackground();
            }
        }
    });
}

// Обновить списки без сброса текущего фильтра/скролла
async function refreshListsFromBackground() {
    try {
        const response = await sendMessage({ action: 'popup_loaded' });
        if (!response) return;
        currentData = response;
        renderTopics(response.favorites);
        renderQMS(response.qms);
        renderMentions(response.mentions);
        updateStats(response);
        // Обновляем текущий фильтр чтобы показать новые элементы
        if (currentFilter) filterTopics(currentFilter);
        updateLastUpdateTime();
    } catch (e) { console.warn('refreshListsFromBackground error:', e); }
}

function updateCountersFromCounts(counts) {
    if (currentData) {
        currentData.favorites.count = counts.favorites;
        currentData.qms.count       = counts.qms;
        currentData.mentions.count  = counts.mentions;
    }
    const favN = elements.statFavorites?.querySelector('.stat-number');
    if (favN) favN.textContent = counts.favorites;
    const qmsN = elements.statQms?.querySelector('.stat-number');
    if (qmsN) qmsN.textContent = counts.qms;
    const menN = elements.statMentions?.querySelector('.stat-number');
    if (menN) menN.textContent = counts.mentions;
}

// ── Clock ────────────────────────────────────────────────────
function initializeClock() {
    const timeEl = document.getElementById('current-time');
    const dateEl = document.getElementById('current-date');
    if (!timeEl || !dateEl) return;
    const MONTHS = {
        ru: ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'],
        en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        de: ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'],
        uk: ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'],
    };
    async function tick() {
        const now = new Date();
        timeEl.textContent = String(now.getHours()).padStart(2,'0') + ':' +
                             String(now.getMinutes()).padStart(2,'0');
        let lang = 'ru';
        try { const r = await chrome.storage.local.get(['ui_language']); lang = r.ui_language || 'ru'; } catch(e){}
        const months = MONTHS[lang] || MONTHS['ru'];
        dateEl.textContent = `${now.getDate()} ${months[now.getMonth()]}`;
    }
    tick();
    setInterval(tick, 60000);
    chrome.storage.onChanged.addListener((changes) => { if (changes.ui_language) tick(); });
}

// ── Theme ─────────────────────────────────────────────────────
async function applyThemeAndColors() {
    const data  = await chrome.storage.local.get(['theme_mode','accent_color']);
    const theme = data.theme_mode || 'dark';
    if (theme === 'auto') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', dark ? 'dark' : 'light');
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            chrome.storage.local.get(['theme_mode'], d => {
                if (d.theme_mode === 'auto')
                    document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light');
            });
        });
    } else {
        document.body.setAttribute('data-theme', theme);
    }
    let _accent = data.accent_color || 'blue';
    if (_accent === 'green') _accent = 'teal';
    if (_accent === 'pink' || _accent === 'red') _accent = 'blue';
    document.body.setAttribute('data-accent', _accent);
}

// ── Font settings ────────────────────────────────────────────
const FONT_FAMILIES = {
    'system':        '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'inter':         '"Inter", -apple-system, sans-serif',
    'roboto':        '"Roboto", -apple-system, sans-serif',
    'open-sans':     '"Open Sans", -apple-system, sans-serif',
    'pt-sans':       '"PT Sans", -apple-system, sans-serif',
    'ubuntu':        'Ubuntu, -apple-system, sans-serif',
    'noto-sans':     '"Noto Sans", -apple-system, sans-serif',
    'source-sans':   '"Source Sans Pro", -apple-system, sans-serif',
    'verdana':       'Verdana, Geneva, sans-serif',
    'comfortaa':     '"Comfortaa", cursive, -apple-system, sans-serif',
    'nunito':        '"Nunito", -apple-system, sans-serif',
    'manrope':       '"Manrope", -apple-system, sans-serif',
    'rubik':         '"Rubik", -apple-system, sans-serif',
    'montserrat':    '"Montserrat", -apple-system, sans-serif',
    'jetbrains-mono':'"JetBrains Mono", "Courier New", monospace, -apple-system, sans-serif',
    'bricolage':     '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':         '"Onest", -apple-system, sans-serif',
    'geologica':     '"Geologica", -apple-system, sans-serif',
};
const FONT_SIZES = { xs:'12px', small:'14px', medium:'16px', large:'18px', xl:'20px', xxl:'22px' };

async function applyFontSettings() {
    const data = await chrome.storage.local.get(['font_family','font_size','line_height']);
    if (data.font_family && FONT_FAMILIES[data.font_family])
        document.body.style.fontFamily = FONT_FAMILIES[data.font_family];
    if (data.font_size && FONT_SIZES[data.font_size]) {
        const base = parseInt(FONT_SIZES[data.font_size]);
        const root = document.documentElement;
        root.style.setProperty('--font-xs', `${base-6}px`);
        root.style.setProperty('--font-sm', `${base-4}px`);
        root.style.setProperty('--font-md', `${base-3}px`);
        root.style.setProperty('--font-lg', `${base-2}px`);
        root.style.setProperty('--font-xl', `${base}px`);
    }
    if (data.line_height) document.body.style.lineHeight = data.line_height;
}

// ── DOM Cache ────────────────────────────────────────────────
function cacheElements() {
    elements = {
        main:           document.querySelector('main'),
        username:       document.getElementById('user-name'),
        refresh:        document.getElementById('refresh'),
        options:        document.getElementById('options'),
        statQms:        document.getElementById('stat-qms'),
        statFavorites:  document.getElementById('stat-favorites'),
        statMentions:   document.getElementById('stat-mentions'),
        themeActions:   document.getElementById('theme-actions'),
        openAll:        document.getElementById('themes-open-all'),
        openPinned:     document.getElementById('themes-open-all-pin'),
        readAll:        document.getElementById('themes-read-all'),
        loadingSkeleton: document.getElementById('loading-skeleton'),
        emptyState:     document.getElementById('empty-state'),
        emptyTitle:     document.getElementById('empty-title'),
        topicsList:     document.getElementById('topic-list'),
        qmsList:        document.getElementById('qms-list'),
        mentionsList:   document.getElementById('mentions-list'),
        lastUpdateTime: document.getElementById('last-update-time'),
        refreshBtn:     document.getElementById('refresh-btn'),
        settingsBtn:    document.getElementById('settings-btn'),
        topicTemplate:  document.getElementById('tpl-topic-card'),
        topicTemplateSimple: document.getElementById('tpl-topic-card-simple'),
    };
}

// ── Event listeners ──────────────────────────────────────────
function setupEventListeners() {
    elements.username.addEventListener('click', () => openTab('user'));
    elements.refresh.addEventListener('click', handleRefreshClick);
    elements.options.addEventListener('click', () => openTab('options'));

    const compactBtn = document.getElementById('compact-toggle');
    if (compactBtn) compactBtn.addEventListener('click', toggleCompactMode);

    elements.statQms.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
            const prev=settings.show_all_qms; settings.show_all_qms=true;
            if(currentData) renderQMS(currentData.qms);
            currentFilter=null; toggleFilter('qms'); settings.show_all_qms=prev;
        } else if(currentFilter==='qms') { expandAll(); }
        else { openTab('qms'); }
    });
    elements.statFavorites.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
            const prev=settings.show_all_favorites; settings.show_all_favorites=true;
            if(currentData) renderTopics(currentData.favorites);
            currentFilter=null; toggleFilter('favorites'); settings.show_all_favorites=prev;
        } else { if(currentData) renderTopics(currentData.favorites); currentFilter=null; toggleFilter('favorites'); }
    });
    elements.statMentions.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
            const prev=settings.show_all_mentions; settings.show_all_mentions=true;
            if(currentData) renderMentions(currentData.mentions);
            currentFilter=null; toggleFilter('mentions'); settings.show_all_mentions=prev;
        } else { if(currentData) renderMentions(currentData.mentions); currentFilter=null; toggleFilter('mentions'); }
    });

    elements.refreshBtn?.addEventListener('click', () => refreshData());
    elements.settingsBtn?.addEventListener('click', () => openTab('options'));
}

// ── Compact mode ─────────────────────────────────────────────
function toggleCompactMode() {
    settings.compact_mode = !settings.compact_mode;
    document.body.classList.toggle('compact-mode', settings.compact_mode);
    document.getElementById('compact-toggle')?.classList.toggle('active', settings.compact_mode);
    chrome.storage.local.set({ compact_mode: settings.compact_mode });
    applyFontSettings();
}

// ── adjustPopupHeight — ОТКЛЮЧЁН в sidebar ───────────────────
// CSS flex управляет высотой. main всегда flex:1 и скроллируется сам.
function adjustPopupHeight() { /* no-op in sidebar */ }

// ── Инициализация sidebar ────────────────────────────────────
async function initializeSidebar() {
    cacheElements();
    setupEventListeners();
    showLoading(true);

    const response = await sendMessage({ action: 'popup_loaded' });
    if (!response) {
        // Не авторизован — показать сообщение
        showErrorState('Войдите на 4PDA, чтобы использовать расширение.');
        return;
    }

    currentData = response;
    settings.simple_list        = response.settings.toolbar_simple_list;
    settings.default_view       = response.settings.toolbar_default_view || 'favorites';
    settings.show_all_favorites = response.settings.show_all_favorites || false;
    settings.show_all_qms       = response.settings.show_all_qms       || false;
    settings.show_all_mentions  = response.settings.show_all_mentions  || false;
    settings.bw_icons           = response.settings.bw_icons           || false;
    settings.accent_color       = response.settings.accent_color       || 'blue';
    settings.compact_mode       = response.settings.compact_mode       || false;

    if (settings.bw_icons) document.body.classList.add('bw-icons');
    document.body.setAttribute('data-accent', settings.accent_color);
    if (settings.compact_mode) {
        document.body.classList.add('compact-mode');
        document.getElementById('compact-toggle')?.classList.add('active');
    }

    // Пользователь
    const usernameText = elements.username.querySelector('.user-name-text');
    if (usernameText) usernameText.textContent = response.user_name;

    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar && response.user_avatar_url) {
        userAvatar.src = response.user_avatar_url;
        userAvatar.onload  = () => { userAvatar.style.display = 'block'; document.querySelector('.user-icon-fallback').style.display = 'none'; };
        userAvatar.onerror = () => { userAvatar.style.display = 'none'; };
    }

    renderTopics(response.favorites);
    renderQMS(response.qms);
    renderMentions(response.mentions);
    setupActionButtons();
    updateStats(response);

    // Sidebar по умолчанию показывает список тем (не collapsed)
    const defaultView = settings.default_view === 'collapsed' ? 'favorites' : settings.default_view;
    filterTopics(defaultView);

    updateLastUpdateTime();
    showLoading(false);

    // ── Запуск polling (работает всегда, независимо от close_on_open) ──
    startSidebarPolling();
}

// ── Sidebar polling — каждые 30 секунд ───────────────────────
function startSidebarPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    pollInterval = setInterval(async () => {
        try {
            const counts = await sendMessage({ action: 'get_counts' });
            if (counts) updateCountersFromCounts(counts);
        } catch (e) { /* ignore */ }
    }, SIDEBAR_POLL_MS);
}

window.addEventListener('beforeunload', () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
});

// ── Storage changes ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, ns) => {
    if (ns !== 'local') return;
    if (changes.accent_color) document.body.setAttribute('data-accent', changes.accent_color.newValue);
    if (changes.bw_icons) document.body.classList.toggle('bw-icons', changes.bw_icons.newValue);
    if (changes.theme_mode) applyThemeAndColors();
    if (changes.font_family || changes.font_size || changes.line_height) applyFontSettings();
});

// ── Filter / Collapse ────────────────────────────────────────
function toggleFilter(type) {
    if (currentFilter === type) { expandAll(); return; }
    filterTopics(type);
}

function expandAll() {
    // В sidebar нет collapsed — при повторном клике разворачиваем все
    currentFilter = null;
    showElement(elements.main);
    showElement(elements.themeActions);
    if (currentData) updateStats(currentData);
}

function filterTopics(type) {
    try {
        currentFilter = type;

        if (type === 'favorites') {
            showElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            showElement(elements.themeActions);
            const hasItems = currentData?.favorites?.list?.some(f => !f.viewed);
            if (!hasItems) showEmptyState(true, 'Все темы прочитаны');
            else showEmptyState(false);
        } else if (type === 'qms') {
            hideElement(elements.topicsList);
            showElement(elements.qmsList);
            hideElement(elements.mentionsList);
            // FIX: themeActions always visible
            const hasItems = currentData?.qms?.list?.some(d => d.unread && !d.viewed);
            if (!hasItems) showEmptyState(true, 'Нет новых сообщений');
            else showEmptyState(false);
        } else if (type === 'mentions') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            showElement(elements.mentionsList);
            // FIX: themeActions always visible
            const hasItems = currentData?.mentions?.list?.some(m => m.unread && !m.viewed);
            if (!hasItems) showEmptyState(true, 'Нет упоминаний');
            else showEmptyState(false);
        }

        updateStats(currentData);
        showElement(elements.main);
    } catch (e) { console.error('filterTopics error:', e); }
}

// ── Update stats ─────────────────────────────────────────────
function updateStats(data) {
    if (!data) return;
    const favN = elements.statFavorites?.querySelector('.stat-number');
    if (favN) favN.textContent = data.favorites.count;
    const qmsN = elements.statQms?.querySelector('.stat-number');
    if (qmsN) qmsN.textContent = data.qms.count;
    const menN = elements.statMentions?.querySelector('.stat-number');
    if (menN) menN.textContent = data.mentions.count;

    [elements.statFavorites, elements.statQms, elements.statMentions].forEach(el => el?.classList.remove(CLASS_ACTIVE));
    if (currentFilter === 'favorites') elements.statFavorites?.classList.add(CLASS_ACTIVE);
    else if (currentFilter === 'qms')  elements.statQms?.classList.add(CLASS_ACTIVE);
    else if (currentFilter === 'mentions') elements.statMentions?.classList.add(CLASS_ACTIVE);
}

// ── Render Topics ────────────────────────────────────────────
function renderTopics(favoritesData) {
    if (!favoritesData?.list?.length) { elements.topicsList.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    const tpl  = settings.simple_list ? elements.topicTemplateSimple : elements.topicTemplate;
    let list   = settings.show_all_favorites ? favoritesData.list : favoritesData.list.filter(t => !t.viewed);
    list.forEach((t, i) => frag.appendChild(createTopicCard(t, tpl, i, false)));
    elements.topicsList.innerHTML = '';
    elements.topicsList.appendChild(frag);
}

function createTopicCard(topic, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    card.id = `topic_${topic.id}`;
    card.style.animationDelay = `${index * 0.04}s`;
    card.classList.add(isRead ? CLASS_READ : CLASS_UNREAD);
    if (topic.pin) { card.classList.add(CLASS_PINNED); card.querySelector('.topic-pin-icon')?.classList.remove(CLASS_HIDDEN); }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) { titleEl.textContent = decodeHtmlEntities(topic.title); card.title = titleEl.textContent; }

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl   = card.querySelector('.topic-time');
        if (authorEl && topic.last_user_name) authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(topic.last_user_name)}`;
        if (timeEl && topic.last_post_ts) timeEl.textContent = `• ${formatRelativeTime(topic.last_post_ts)}`;
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (isRead && markReadBtn) { markReadBtn.remove(); }
    else if (markReadBtn) {
        markReadBtn.addEventListener('click', e => { e.stopPropagation(); markTopicAsRead(topic.id); });
    }

    card.addEventListener('click', () => {
        if (currentData?.favorites?.list) {
            const t = currentData.favorites.list.find(x => x.id === topic.id);
            if (t) t.viewed = true;
            currentData.favorites.count = Math.max(0, currentData.favorites.list.filter(x => !x.viewed).length);
        }
        openTab('favorites', { id: topic.id, view: 'getnewpost' });
        _animateCardRemoval(card, () => filterTopics(currentFilter || 'favorites'));
        setTimeout(updateCountersFromBackground, 600);
    });
    return clone;
}

// ── Render QMS ───────────────────────────────────────────────
function renderQMS(qmsData) {
    if (!qmsData?.list?.length) { elements.qmsList.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    const tpl  = settings.simple_list ? elements.topicTemplateSimple : elements.topicTemplate;
    let list   = settings.show_all_qms ? qmsData.list : qmsData.list.filter(d => d.unread && !d.viewed);
    list.forEach((d, i) => frag.appendChild(createQMSCard(d, tpl, i)));
    elements.qmsList.innerHTML = '';
    elements.qmsList.appendChild(frag);
}

function createQMSCard(dialog, template, index) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    card.id = `qms_${dialog.id}`;
    card.classList.add(CLASS_UNREAD);
    card.setAttribute('data-opponent-name', dialog.opponent_name || '');
    card.setAttribute('data-opponent-id', dialog.opponent_id || '');
    card.setAttribute('data-dialog-id', dialog.id || '');

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) typeIcon.innerHTML = '<use href="#icon-mail"></use>';
    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) pinIcon.classList.add('hidden');

    // Title: subject if available, else opponent_name
    const titleEl = card.querySelector('.topic-title');
    const metaEl  = card.querySelector('.topic-meta');
    if (titleEl) titleEl.textContent = decodeHtmlEntities(dialog.subject || dialog.title || dialog.opponent_name || '');
    if (metaEl) {
        let metaText = decodeHtmlEntities(dialog.opponent_name || '');
        if (dialog.last_msg_ts) metaText += (metaText ? ' • ' : '') + formatRelativeTime(dialog.last_msg_ts);
        metaEl.textContent = metaText;
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) markReadBtn.remove();

    // Open-in-tab button
    const actionsContainer = card.querySelector('.card-actions');
    if (actionsContainer) {
        const openTabBtn = document.createElement('button');
        openTabBtn.className = 'action-icon open-tab interactive';
        openTabBtn.title = 'Открыть диалог';
        openTabBtn.innerHTML = '<svg class="icon"><use href="#icon-external-link"></use></svg>';
        openTabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id });
        });
        actionsContainer.appendChild(openTabBtn);
    }

    // ── Inline chat ────────────────────────────────────────
    const cardBody = card.querySelector('.card-body');
    const inlineChat = document.createElement('div');
    inlineChat.className = 'qms-inline-chat hidden';
    inlineChat.innerHTML = `
        <div class="qms-history"></div>
        <div class="qms-emoji-picker hidden"></div>
        <div class="qms-reply-form">
            <textarea class="qms-textarea" placeholder="Сообщение..."></textarea>
            <div class="qms-reply-actions">
                <button class="action-btn qms-btn-emoji" title="Смайлики"><svg class="icon-sm"><use href="#icon-smile"></use></svg></button>
                <button class="action-btn qms-btn-send" title="Отправить (Ctrl+Enter)">Отправить</button>
                <button class="action-btn qms-btn-cancel" title="Свернуть">Свернуть</button>
            </div>
        </div>`;
    cardBody.appendChild(inlineChat);
    inlineChat.addEventListener('click', e => e.stopPropagation());

    const EMOJIS = ['😀','😂','🤣','😊','😍','😒','😘','😁','😉','😎','😋','😜','🤔','🙄','😏','😔','😴','🤤','😷','🤢','🤮','🤧','😵','🤯','🤠','🥳','🤓','👍','👎','👏','🤝','🍻','🔥','❤️','💔','💯','🤷‍♂️','🤦‍♂️'];
    const emojiPicker = inlineChat.querySelector('.qms-emoji-picker');
    const textarea    = inlineChat.querySelector('.qms-textarea');
    EMOJIS.forEach(emo => {
        const span = document.createElement('span');
        span.textContent = emo; span.className = 'qms-emoji-item';
        span.onclick = (e) => {
            e.stopPropagation();
            const s = textarea.selectionStart, en = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, s) + emo + textarea.value.substring(en);
            textarea.selectionStart = textarea.selectionEnd = s + emo.length;
            textarea.focus();
        };
        emojiPicker.appendChild(span);
    });

    let isExpanded = false;
    let lastMessageId = '0';

    card.addEventListener('click', async (e) => {
        if (e.target.closest('.card-actions')) return;
        if (isExpanded) { isExpanded = false; inlineChat.classList.add('hidden'); return; }
        isExpanded = true;
        inlineChat.classList.remove('hidden');
        const historyContainer = inlineChat.querySelector('.qms-history');
        historyContainer.innerHTML = '<div class="qms-loading-text">Загрузка...</div>';
        try {
            const threadUrl = `https://4pda.to/forum/index.php?act=qms&mid=${dialog.opponent_id}&t=${dialog.id}`;
            const res = await fetch(threadUrl);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buffer = await res.arrayBuffer();
            const html = new TextDecoder('windows-1251').decode(buffer);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const messages = doc.querySelectorAll('#scroll-thread .list-group-item[data-message-id]');
            historyContainer.innerHTML = '';
            if (!messages.length) historyContainer.innerHTML = '<div class="qms-loading-text">Нет сообщений</div>';
            messages.forEach(msg => {
                const msgId = msg.getAttribute('data-message-id');
                if (msgId) lastMessageId = msgId;
                const content = msg.querySelector('.msg-content');
                if (content) {
                    const div = document.createElement('div');
                    div.className = msg.classList.contains('our-message') ? 'qms-msg out' : 'qms-msg in';
                    div.innerHTML = content.innerHTML;
                    historyContainer.appendChild(div);
                }
            });
            setTimeout(() => historyContainer.scrollTop = historyContainer.scrollHeight, 50);
        } catch(err) {
            historyContainer.innerHTML = '<div class="qms-loading-text">Ошибка загрузки</div>';
        }
    });

    inlineChat.querySelector('.qms-btn-cancel').addEventListener('click', (e) => {
        e.stopPropagation(); isExpanded = false; inlineChat.classList.add('hidden');
    });
    inlineChat.querySelector('.qms-btn-emoji').addEventListener('click', (e) => {
        e.stopPropagation(); emojiPicker.classList.toggle('hidden');
    });

    const sendHandler = async (e) => {
        if (e) e.stopPropagation();
        const text = textarea.value.trim();
        if (!text) return;
        const btnSend = inlineChat.querySelector('.qms-btn-send');
        btnSend.disabled = true; btnSend.textContent = '...';
        try {
            await sidebarQmsApiRequest('send-message', dialog.opponent_id, dialog.id, {
                'message': text, 'forward-messages-username': '',
                'forward-thread-username': '', 'attaches': '', 'after-message': lastMessageId
            });
            textarea.value = '';
            if (currentData?.qms?.list) {
                const d = currentData.qms.list.find(x => x.id === dialog.id);
                if (d) d.viewed = true;
                currentData.qms.count = Math.max(0, currentData.qms.count - 1);
            }
            const qmsN = elements.statQms?.querySelector('.stat-number');
            if (qmsN && currentData) qmsN.textContent = currentData.qms.count;
            if (!settings.show_all_qms) {
                _animateCardRemoval(card, () => filterTopics(currentFilter || 'qms'));
            } else {
                isExpanded = false; inlineChat.classList.add('hidden');
                card.classList.remove(CLASS_UNREAD); card.classList.add(CLASS_READ);
            }
            setTimeout(updateCountersFromBackground, 600);
        } catch(err) {
            btnSend.disabled = false; btnSend.textContent = 'Ошибка!';
            setTimeout(() => { btnSend.textContent = 'Отправить'; }, 2000);
        }
    };

    inlineChat.querySelector('.qms-btn-send').addEventListener('click', sendHandler);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendHandler(); }
    });

    return clone;
}

async function sidebarQmsApiRequest(action, mid, t, additionalData = {}) {
    const url = 'https://4pda.to/forum/index.php?act=qms-xhr';
    const formData = new FormData();
    formData.append('action', action);
    formData.append('mid', mid);
    formData.append('t', t);
    for (const [k, v] of Object.entries(additionalData)) formData.append(k, v);
    const response = await fetch(url, { method: 'POST', body: formData, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { html: text }; }
}

// ── Render Mentions ──────────────────────────────────────────
function renderMentions(mentionsData) {
    if (!mentionsData?.list?.length) { elements.mentionsList.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    const tpl  = settings.simple_list ? elements.topicTemplateSimple : elements.topicTemplate;
    let list   = settings.show_all_mentions ? mentionsData.list : mentionsData.list.filter(m => m.unread && !m.viewed);
    list.forEach((m, i) => frag.appendChild(createMentionCard(m, tpl, i)));
    elements.mentionsList.innerHTML = '';
    elements.mentionsList.appendChild(frag);
}

function createMentionCard(mention, template, index) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    card.id = `mention_${mention.id}`;
    card.classList.add(CLASS_UNREAD);
    const titleEl = card.querySelector('.topic-title');
    if (titleEl) titleEl.textContent = decodeHtmlEntities(mention.title || '');
    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl   = card.querySelector('.topic-time');
        if (authorEl && mention.poster_name) authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(mention.poster_name)}`;
        if (timeEl && mention.timestamp) timeEl.textContent = `• ${formatRelativeTime(mention.timestamp)}`;
    }
    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) markReadBtn.remove();
    card.addEventListener('click', () => {
        card.classList.add(CLASS_READ); card.classList.remove(CLASS_UNREAD);
        openTab('mentions', { topic_id: mention.topic_id, post_id: mention.post_id });
        setTimeout(updateCountersFromBackground, 500);
    });
    return clone;
}

// ── Action buttons ───────────────────────────────────────────
function setupActionButtons() {
    if (elements.openAll) elements.openAll.onclick = () => createPort('themes-open-all');
    if (elements.openPinned) elements.openPinned.onclick = () => createPort('themes-open-all-pin');
    if (elements.readAll) elements.readAll.onclick = () => createPort('themes-read-all');
}

// ── Mark as read ─────────────────────────────────────────────
function _animateCardRemoval(card, onDone) {
    if (!card) { onDone?.(); return; }
    const h = card.offsetHeight;
    card.style.transition = 'opacity 0.16s ease, transform 0.16s ease, max-height 0.20s ease, margin 0.20s ease, padding 0.20s ease';
    card.style.overflow   = 'hidden';
    card.style.maxHeight  = h + 'px';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(14px)';
    setTimeout(() => {
        card.style.maxHeight    = '0px';
        card.style.marginBottom = '0px';
        card.style.paddingTop   = '0px';
        card.style.paddingBottom= '0px';
    }, 160);
    setTimeout(() => { card.remove(); onDone?.(); }, 390);
}

async function markTopicAsRead(topicId) {
    try {
        const result = await sendMessage({ action: 'mark_as_read', id: topicId });
        if (result) {
            // Помечаем в данных сразу
            if (currentData?.favorites?.list) {
                const t = currentData.favorites.list.find(x => x.id === topicId);
                if (t) t.viewed = true;
                currentData.favorites.count = Math.max(0, currentData.favorites.list.filter(x => !x.viewed).length);
                updateStats(currentData);
            }
            const card = document.getElementById(`topic_${topicId}`);
            _animateCardRemoval(card, () => filterTopics(currentFilter || 'favorites'));
        }
    } catch (e) { console.error('markTopicAsRead error:', e); }
}

// ── Refresh ──────────────────────────────────────────────────
async function refreshData() {
    const prevFilter = currentFilter;
    showLoading(true);
    try {
        await sendMessage({ action: 'force_update' });
        const response = await sendMessage({ action: 'popup_loaded' });
        if (response) {
            currentData = response;
            renderTopics(response.favorites);
            renderQMS(response.qms);
            renderMentions(response.mentions);
            setupActionButtons();
            const usernameText = elements.username.querySelector('.user-name-text');
            if (usernameText) usernameText.textContent = response.user_name;
            updateStats(response);
            if (prevFilter) filterTopics(prevFilter);
            else filterTopics('favorites');
            updateLastUpdateTime();
        }
    } catch (e) { console.error('refreshData error:', e); }
    finally { showLoading(false); }
}

async function handleRefreshClick() {
    elements.refresh.classList.add('spinning');
    try { await refreshData(); }
    finally { setTimeout(() => elements.refresh.classList.remove('spinning'), 600); }
}

// ── openTab (sidebar: НЕ закрывает окно, всегда открывает вкладку активной) ─────────────────────
function openTab(what, options = {}) {
    // В сайдбаре всегда открываем вкладку в фокусе (active:true),
    // т.к. toolbar_open_theme_hide=false открывает в фоне — пользователь не видит переход.
    chrome.runtime.sendMessage({ action: 'open_url', what, sidebar: true, ...options });
}

// ── Counters from background ─────────────────────────────────
async function updateCountersFromBackground() {
    try {
        const counts = await sendMessage({ action: 'get_counts' });
        if (counts) updateCountersFromCounts(counts);
    } catch(e) {}
}

// ── Port (batch operations) ──────────────────────────────────
function createPort(name) {
    const port = chrome.runtime.connect({ name });
    port.onMessage.addListener(msg => {
        const card = document.getElementById(`topic_${msg.id}`);
        if (card) card.classList.add(CLASS_READ);
        if (currentData) { currentData.favorites.count = msg.count; updateStats(currentData); }
    });
    return port;
}

// ── Loading / Empty state ────────────────────────────────────
function showLoading(show) {
    if (show) {
        showElement(elements.loadingSkeleton);
        hideElement(elements.emptyState);
        hideElement(elements.topicsList);
        hideElement(elements.qmsList);
        hideElement(elements.mentionsList);
    } else {
        hideElement(elements.loadingSkeleton);
    }
}

function showEmptyState(show, msg = null) {
    if (show) {
        if (msg) elements.emptyTitle.textContent = msg;
        showElement(elements.emptyState);
        hideElement(elements.topicsList);
        hideElement(elements.qmsList);
        hideElement(elements.mentionsList);
    } else {
        hideElement(elements.emptyState);
    }
}

function updateLastUpdateTime() {
    const now = new Date();
    if (elements.lastUpdateTime)
        elements.lastUpdateTime.textContent = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
}

// ── Helpers ──────────────────────────────────────────────────
function showElement(el) { el?.classList.remove(CLASS_HIDDEN); }
function hideElement(el) { el?.classList.add(CLASS_HIDDEN); }

function decodeHtmlEntities(text) {
    if (!text) return '';
    const ta = document.createElement('textarea');
    ta.innerHTML = text;
    return ta.value;
}

function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now()/1000 - ts;
    if (diff < 60)     return 'только что';
    if (diff < 3600)   return `${Math.floor(diff/60)} мин. назад`;
    if (diff < 86400)  return `${Math.floor(diff/3600)} ч. назад`;
    if (diff < 604800) return `${Math.floor(diff/86400)} дн. назад`;
    return `${Math.floor(diff/604800)} нед. назад`;
}

function sendMessage(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
            });
        } catch (e) { reject(e); }
    });
}

// ══════════════════════════════════════════════
// 4Pulse i18n — sidebar translations
// ══════════════════════════════════════════════
const SIDEBAR_TRANSLATIONS = {
    ru: { popup_stats:'Статистика', popup_topics:'Темы', popup_mentions:'Ответы', popup_open_all:'Открыть все', popup_pinned:'Закреп.', popup_read_all:'Прочитать', popup_empty:'Непрочитанных тем нет', radio_mini_radio:'🎵 Радио' },
    en: { popup_stats:'Stats', popup_topics:'Topics', popup_mentions:'Mentions', popup_open_all:'Open all', popup_pinned:'Pinned', popup_read_all:'Read all', popup_empty:'No unread topics', radio_mini_radio:'🎵 Radio' },
    de: { popup_stats:'Statistik', popup_topics:'Themen', popup_mentions:'Erwähnung', popup_open_all:'Alle öffnen', popup_pinned:'Angeh.', popup_read_all:'Alle gel.', popup_empty:'Keine ungelesenen Themen', radio_mini_radio:'🎵 Radio' },
    uk: { popup_stats:'Статистика', popup_topics:'Теми', popup_mentions:'Відповіді', popup_open_all:'Відкрити всі', popup_pinned:'Закріп.', popup_read_all:'Прочитати', popup_empty:'Непрочитаних тем немає', radio_mini_radio:'🎵 Радіо' },
};

async function applySidebarLanguage() {
    try {
        const result = await chrome.storage.local.get(['ui_language']);
        const lang = result.ui_language || 'ru';
        const t = SIDEBAR_TRANSLATIONS[lang] || SIDEBAR_TRANSLATIONS['ru'];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (t[key]) el.textContent = t[key];
        });
    } catch(e) {}
}

document.addEventListener('DOMContentLoaded', () => setTimeout(applySidebarLanguage, 50));

// ════════════════════════════════════════════════════════
// 🎵 MINI RADIO PLAYER — sidebar
// ════════════════════════════════════════════════════════
async function initSidebarRadio() {
    try {
        const r = await chrome.storage.local.get(['radio_enabled']);
        if (!r.radio_enabled) return;

        const bar    = document.getElementById('mini-radio-bar');
        const nameEl = document.getElementById('mini-radio-name');
        const volEl  = document.getElementById('mini-radio-vol');
        const btn    = document.getElementById('mini-radio-btn');
        if (!bar) return;

        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state) {
            bar.style.display = 'flex';
            if (nameEl && state.stationName) nameEl.textContent = state.stationName;
            if (volEl)  volEl.value = state.volume ?? 70;
            setSidebarRadioBtn(btn, state.isPlaying);
        }

        btn?.addEventListener('click', async () => {
            const st = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
            if (st?.isPlaying) {
                await chrome.runtime.sendMessage({ action: 'radio_pause' });
                setSidebarRadioBtn(btn, false);
            } else {
                const r2 = await chrome.storage.local.get(['radio_station','radio_station_name']);
                if (r2.radio_station) {
                    await chrome.runtime.sendMessage({ action: 'radio_play', station: r2.radio_station, stationName: r2.radio_station_name });
                    setSidebarRadioBtn(btn, true);
                    if (nameEl && r2.radio_station_name) nameEl.textContent = r2.radio_station_name;
                }
            }
        });

        volEl?.addEventListener('input', () => {
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: parseInt(volEl.value) });
        });

        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.action === 'radio_state') {
                setSidebarRadioBtn(btn, msg.state?.isPlaying);
                if (nameEl && msg.state?.stationName) nameEl.textContent = msg.state.stationName;
            }
        });

        // Also show radio bar when storage changes (radio enabled externally)
        chrome.storage.onChanged.addListener((changes) => {
            if (changes.radio_enabled) {
                if (changes.radio_enabled.newValue) {
                    bar.style.display = 'flex';
                    initSidebarRadio();
                } else {
                    bar.style.display = 'none';
                }
            }
        });
    } catch(e) { console.warn('Sidebar radio init:', e); }
}

function setSidebarRadioBtn(btn, isPlaying) {
    if (!btn) return;
    btn.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Пауза' : 'Играть';
}

document.addEventListener('DOMContentLoaded', () => initSidebarRadio());
