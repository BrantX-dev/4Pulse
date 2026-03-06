// Constants
const CLASS_HIDDEN = 'hidden';
const CLASS_ACTIVE = 'active';
const CLASS_READ = 'read';
const CLASS_UNREAD = 'unread';
const CLASS_PINNED = 'pinned';
const CLASS_LOADING = 'loading';

// ── Анимация смены числа в счётчике (flip-down) ──────────────────────────
function animateCounter(el, newValue) {
    if (!el) return;
    const newText = String(newValue);
    if (el.textContent === newText) return;   // уже такое значение — не анимируем

    // Снимаем предыдущую анимацию если ещё идёт
    el.classList.remove('animating-out', 'animating-in');

    // Фаза 1: старое число уезжает вверх
    el.classList.add('animating-out');

    const onOutEnd = () => {
        el.removeEventListener('animationend', onOutEnd);
        el.classList.remove('animating-out');

        // Ставим новое значение и анимируем въезд снизу
        el.textContent = newText;
        el.classList.add('animating-in');

        const onInEnd = () => {
            el.removeEventListener('animationend', onInEnd);
            el.classList.remove('animating-in');
        };
        el.addEventListener('animationend', onInEnd, { once: true });
    };
    el.addEventListener('animationend', onOutEnd, { once: true });
}



// State
let elements = {};
let settings = {
    simple_list: false,
    close_on_open: true,
    default_view: 'collapsed',
    show_all_favorites: false,
    show_all_qms: false,
    show_all_mentions: false,
    bw_icons: false,
    accent_color: 'purple'
};
let currentData = null;
let currentFilter = null;
let pollInterval = null;   // единственный интервал авторежима
let qmsObserver = null;
let loadingQmsSubjects = new Set();

// 🎯 Focus & 🔕 Mute state (Set<string> of topic IDs)
let focusedTopics = new Set();
let mutedTopics = new Set();

// ── Priority Blink Driver (runs in UI context — reliable setInterval) ──
let _popupBlinkTimer = null;
let _popupBlinkPhase = false;

function startPopupBlink() {
    if (_popupBlinkTimer) return;
    _popupBlinkPhase = false;
    _popupBlinkTimer = setInterval(() => {
        _popupBlinkPhase = !_popupBlinkPhase;
        if (_popupBlinkPhase) {
            // RED — visible against ANY accent color (orange, blue, purple, teal)
            chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
            chrome.action.setBadgeText({ text: '!!' }).catch(() => {});
        } else {
            chrome.action.setBadgeBackgroundColor({ color: '#1A8FFF' }).catch(() => {});
            // Restore real count
            const count = (currentData?.favorites?.count || 0) + (currentData?.qms?.count || 0);
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' }).catch(() => {});
        }
    }, 600);
}

function stopPopupBlink() {
    if (_popupBlinkTimer) { clearInterval(_popupBlinkTimer); _popupBlinkTimer = null; }
}

async function checkAndStartBlink() {
    try {
        const s = await chrome.storage.local.get(['priority_blinking']);
        if (s.priority_blinking) startPopupBlink(); else stopPopupBlink();
    } catch(e) {}
}

// Load focus/mute state from storage
async function loadFocusMuteState() {
    try {
        const stored = await chrome.storage.local.get(['focused_topics', 'muted_topics']);
        focusedTopics = new Set((stored.focused_topics || []).map(String));
        mutedTopics   = new Set((stored.muted_topics   || []).map(String));
    } catch(e) { console.warn('loadFocusMuteState:', e); }
}

async function saveFocusedTopics() {
    await chrome.storage.local.set({ focused_topics: [...focusedTopics] });
}

async function saveMutedTopics() {
    await chrome.storage.local.set({ muted_topics: [...mutedTopics] });
}

// Toggle focus for a topic
async function toggleTopicFocus(topicId) {
    const id = String(topicId);
    if (focusedTopics.has(id)) {
        focusedTopics.delete(id);
    } else {
        focusedTopics.add(id);
        mutedTopics.delete(id);
        await saveMutedTopics();
    }
    await saveFocusedTopics();
    const anyFocusedUnread = currentData?.favorites?.list?.some(
        t => !t.viewed && focusedTopics.has(String(t.id))
    );
    if (anyFocusedUnread) {
        // Start blink immediately — don't wait for next poll
        await chrome.storage.local.set({ priority_blinking: true });
        chrome.runtime.sendMessage({ action: 'start_priority_blink' }).catch(() => {});
    } else {
        await chrome.storage.local.set({ priority_blinking: false });
        chrome.runtime.sendMessage({ action: 'stop_priority_blink' }).catch(() => {});
    }
}

// Toggle mute for a topic
async function toggleTopicMute(topicId) {
    const id = String(topicId);
    if (mutedTopics.has(id)) {
        mutedTopics.delete(id);
    } else {
        mutedTopics.add(id);
        focusedTopics.delete(id); // Can't be both focused and muted
        await saveFocusedTopics();
    }
    await saveMutedTopics();
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 🚀 Setup real-time count updates listener
        setupRealtimeUpdates();

        // 🕐 Initialize clock
        initializeClock();

        // 🎨 Apply theme and colors
        await applyThemeAndColors();

        await initializePopup();

        // 🔤 Apply font settings (ПОСЛЕ initializePopup, когда compact-mode уже установлен)
        await applyFontSettings();
    } catch (error) {
        console.error('Critical error during initialization:', error);
        showErrorState(error.message);
    }
});

// Show error state
function showErrorState(errorMessage) {
    document.body.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #ff4444;">
            <h3>Ошибка загрузки</h3>
            <p>${errorMessage}</p>
            <button onclick="location.reload()" style="margin-top: 10px; padding: 8px 16px; cursor: pointer;">
                Перезагрузить
            </button>
        </div>
    `;
}

// 🚀 Setup real-time count updates from background
function setupRealtimeUpdates() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'counts_updated' && message.counts) {
            updateCountersFromCounts(message.counts);
        }
    });

    // Watch priority_blinking flag — start/stop blink in UI context
    checkAndStartBlink();
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.priority_blinking !== undefined) {
            changes.priority_blinking.newValue ? startPopupBlink() : stopPopupBlink();
        }
    });
}

// 🕐 Initialize and update clock
function initializeClock() {
    const timeEl = document.getElementById('current-time');
    const dateEl = document.getElementById('current-date');

    if (!timeEl || !dateEl) return;

    const MONTHS = {
        ru: ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'],
        en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
        de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
        uk: ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'],
    };

    async function updateClock() {
        const now = new Date();

        // Time HH:MM
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        timeEl.textContent = `${hours}:${minutes}`;

        // Date with localized month
        let lang = 'ru';
        try { const r = await chrome.storage.local.get(['ui_language']); lang = r.ui_language || 'ru'; } catch(e){}
        const months = MONTHS[lang] || MONTHS['ru'];
        const day = now.getDate();
        const month = months[now.getMonth()];
        dateEl.textContent = lang === 'de' ? `${day}. ${month}` : `${day} ${month}`;
    }

    // Обновляем сразу
    updateClock();

    // Обновляем каждую минуту (60000 мс)
    setInterval(updateClock, 60000);
}

// 🚀 Update counters from provided counts object
function updateCountersFromCounts(counts) {
    if (currentData) {
        currentData.favorites.count = counts.favorites;
        currentData.qms.count = counts.qms;
        currentData.mentions.count = counts.mentions;
    }

    const favNumber = elements.statFavorites?.querySelector('.stat-number');
    animateCounter(favNumber, counts.favorites);

    const qmsNumber = elements.statQms?.querySelector('.stat-number');
    animateCounter(qmsNumber, counts.qms);

    const mentNumber = elements.statMentions?.querySelector('.stat-number');
    animateCounter(mentNumber, counts.mentions);

}

// Initialize popup
async function initializePopup() {
    try {
        cacheElements();
        setupEventListeners();
        showLoading(true);

        // 🎯 Load focus/mute state before rendering
        await loadFocusMuteState();

        const response = await sendMessage({ action: 'popup_loaded' });

        if (!response) {
            // ✅ FIX: Показываем сообщение как сайдбар, а не тихо закрываемся
            showLoading(false);
            showErrorState('Войдите на 4PDA, чтобы использовать расширение.');
            return;
        }

        currentData = response;
        settings.simple_list = response.settings.toolbar_simple_list;
        settings.close_on_open = response.settings.toolbar_open_theme_hide;
        settings.default_view = response.settings.toolbar_default_view || 'collapsed';
        settings.show_all_favorites = response.settings.show_all_favorites || false;
        settings.show_all_qms = response.settings.show_all_qms || false;
        settings.show_all_mentions = response.settings.show_all_mentions || false;
        settings.bw_icons = response.settings.bw_icons || false;
        settings.accent_color = response.settings.accent_color || 'purple';
        settings.compact_mode = response.settings.compact_mode || false;


        // 🎨 Apply B&W icons
        if (settings.bw_icons) {
            document.body.classList.add('bw-icons');
        } else {
            document.body.classList.remove('bw-icons');
        }

        // 🎨 Apply accent color via data attribute
        document.body.setAttribute('data-accent', settings.accent_color);

        // 🎨 Apply compact mode
        if (settings.compact_mode) {
            document.body.classList.add('compact-mode');
            document.getElementById('compact-toggle')?.classList.add('active');
        }

        renderPopup(response);
        showLoading(false);
        startPolling();
        await restoreAutoModeIfNeeded();

        // 🔧 FIX: If SW just restarted, data may be stale (all zeros).
        // Trigger a background refresh immediately so counters update quickly.
        const allZero = response.favorites.count === 0 &&
                        response.qms.count === 0 &&
                        response.mentions.count === 0;
        if (allZero) {
            setTimeout(async () => {
                try {
                    await sendMessage({ action: 'force_update' });
                    const fresh = await sendMessage({ action: 'popup_loaded' });
                    if (fresh) {
                        currentData = fresh;
                        renderTopics(fresh.favorites);
                        renderQMS(fresh.qms);
                        renderMentions(fresh.mentions);
                        updateStats(fresh);
                        const usernameText = elements.username.querySelector('.user-name-text');
                        if (usernameText && fresh.user_name) usernameText.textContent = fresh.user_name;
                        const userAvatar = document.getElementById('user-avatar');
                        if (userAvatar && fresh.user_avatar_url) {
                            userAvatar.src = fresh.user_avatar_url;
                            userAvatar.onload = () => { userAvatar.style.display = 'block'; document.querySelector('.user-icon-fallback')?.style?.setProperty('display','none'); };
                        }
                        if (currentFilter) filterTopics(currentFilter); else collapsePopup();
                    }
                } catch (e) { /* silent — popup may already be closed */ }
            }, 300);
        }

    } catch (error) {
        console.error('❌ Failed to initialize popup:', error);
        showErrorState(`Не удалось загрузить данные: ${error.message}`);
    }
}

// 🎨 Listen for settings changes from storage
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        // Update accent color dynamically
        if (changes.accent_color) {
            const newColor = changes.accent_color.newValue;
            document.body.setAttribute('data-accent', newColor);
            settings.accent_color = newColor;
        }

        // Update B&W icons dynamically
        if (changes.bw_icons) {
            const bwEnabled = changes.bw_icons.newValue;

            if (bwEnabled) {
                document.body.classList.add('bw-icons');
            } else {
                document.body.classList.remove('bw-icons');
            }
            settings.bw_icons = bwEnabled;
        }

        // Update font settings dynamically
        if (changes.font_family || changes.font_size || changes.line_height) {
            applyFontSettings();
        }

        // Update theme dynamically
        if (changes.theme_mode) {
            applyThemeSettings();
        }
    }
});

// Cache DOM elements
function cacheElements() {
    elements = {
        main: document.querySelector('main'),
        username: document.getElementById('user-name'),
        refresh: document.getElementById('refresh'),
        options: document.getElementById('options'),
        statQms: document.getElementById('stat-qms'),
        statFavorites: document.getElementById('stat-favorites'),
        statMentions: document.getElementById('stat-mentions'),
        themeActions: document.getElementById('theme-actions'),
        openAll: document.getElementById('themes-open-all'),
        openPinned: document.getElementById('themes-open-all-pin'),
        readAll: document.getElementById('themes-read-all'),
        loadingSkeleton: document.getElementById('loading-skeleton'),
        emptyState: document.getElementById('empty-state'),
        emptyTitle: document.getElementById('empty-title'),
        topicsList: document.getElementById('topic-list'),
        qmsList: document.getElementById('qms-list'),
        mentionsList: document.getElementById('mentions-list'),
        lastUpdateTime: document.getElementById('last-update-time'),
        refreshBtn: document.getElementById('refresh-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        topicTemplate: document.getElementById('tpl-topic-card'),
        topicTemplateSimple: document.getElementById('tpl-topic-card-simple')
    };
}

// Setup event listeners
function setupEventListeners() {
    elements.username.addEventListener('click', () => openTab('user'));
    elements.refresh.addEventListener('click', handleRefreshClick);
    elements.options.addEventListener('click', () => openTab('options'));

    // Compact mode toggle
    const compactToggle = document.getElementById('compact-toggle');
    if (compactToggle) {
        compactToggle.addEventListener('click', toggleCompactMode);
    }

    elements.statQms.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Shift+клик - показать список в попапе
        if (e.shiftKey) {
            // Временно включаем показ всех QMS
            const previousShowAll = settings.show_all_qms;
            settings.show_all_qms = true;
            toggleFilter('qms');
            // Возвращаем обратно после рендеринга
            setTimeout(() => {
                settings.show_all_qms = previousShowAll;
            }, 100);
        } else {
            // Обычный клик - открыть страницу QMS
            openTab('qms');
        }
    });

    elements.statFavorites.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Shift+клик - показать список в попапе
        if (e.shiftKey) {
            // Временно включаем показ всех тем
            const previousShowAll = settings.show_all_favorites;
            settings.show_all_favorites = true;
            toggleFilter('favorites');
            // Возвращаем обратно после рендеринга
            setTimeout(() => {
                settings.show_all_favorites = previousShowAll;
            }, 100);
        } else {
            // Обычный клик - открыть страницу избранного
            openTab('favorites');
        }
    });

    elements.statMentions.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Shift+клик - показать список в попапе
        if (e.shiftKey) {
            // Временно включаем показ всех упоминаний
            const previousShowAll = settings.show_all_mentions;
            settings.show_all_mentions = true;
            toggleFilter('mentions');
            // Возвращаем обратно после рендеринга
            setTimeout(() => {
                settings.show_all_mentions = previousShowAll;
            }, 100);
        } else {
            // Обычный клик - открыть страницу упоминаний
            openTab('mentions');
        }
    });

    elements.refreshBtn?.addEventListener('click', () => refreshData());
    elements.settingsBtn?.addEventListener('click', () => openTab('options'));
}

// Setup action buttons (batch operations)
function setupActionButtons() {
    if (elements.openAll) {
        elements.openAll.onclick = () => {
            const port = createPort('themes-open-all');
            if (settings.close_on_open) {
                window.close();
            }
        };
    }

    if (elements.openPinned) {
        elements.openPinned.onclick = () => {
            const port = createPort('themes-open-all-pin');
            if (settings.close_on_open) {
                window.close();
            }
        };
    }

    if (elements.readAll) {
        elements.readAll.onclick = () => {
            const port = createPort('themes-read-all');
        };
    }
}

// Toggle filter with collapse functionality
function toggleFilter(type) {
    try {
        if (currentFilter === type) {
            collapsePopup();
            return;
        }
        filterTopics(type);
    } catch (error) {
        console.error('Error in toggleFilter:', error);
    }
}

// Collapse popup (hide all lists, show only stats)
function collapsePopup() {
    currentFilter = null;
    hideElement(elements.main);
    // FIX: action buttons remain visible even in collapsed state

    if (currentData) {
        updateStats(currentData);
    }

    // Уменьшаем высоту при коллапсе
    setTimeout(() => {
        const header   = document.querySelector('header');
        const radioBar = document.getElementById('mini-radio-bar');
        const radioBarH = (radioBar && radioBar.style.display !== 'none') ? radioBar.offsetHeight : 0;
        if (header) {
            const headerHeight = header.offsetHeight;
            document.body.style.height = `${headerHeight + radioBarH + 20}px`;
            document.body.style.minHeight = `${headerHeight + radioBarH + 20}px`;
        }
    }, 100);
}

// Filter topics
function filterTopics(type) {
    try {
        currentFilter = type;

        if (type === 'favorites') {
            showElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            showElement(elements.themeActions);

            let hasVisibleItems = false;
            if (currentData.favorites.list && currentData.favorites.list.length > 0) {
                if (settings.show_all_favorites) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.favorites.list.some(f => !f.viewed);
                }
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Все темы прочитаны');
                // FIX: keep themeActions visible even when all topics are read
            } else {
                showEmptyState(false);
            }
        } else if (type === 'qms') {
            hideElement(elements.topicsList);
            showElement(elements.qmsList);
            hideElement(elements.mentionsList);
            // FIX: themeActions always visible

            let hasVisibleItems = false;
            if (currentData.qms.list && currentData.qms.list.length > 0) {
                if (settings.show_all_qms) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.qms.list.some(d => d.unread && !d.viewed);
                }
            } else {
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Нет новых сообщений');
            } else {
                showEmptyState(false);
            }
        } else if (type === 'mentions') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            showElement(elements.mentionsList);
            // FIX: themeActions always visible

            let hasVisibleItems = false;
            if (currentData.mentions.list && currentData.mentions.list.length > 0) {
                if (settings.show_all_mentions) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.mentions.list.some(m => m.unread && !m.viewed);
                }
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Нет новых ответов');
            } else {
                showEmptyState(false);
            }
        }

        updateStats(currentData);
        showElement(elements.main);

        // Применяем правило скролла к новому видимому списку
        const newVisibleList = elements.main.querySelector('.topics-list:not(.hidden)');
        if (newVisibleList) applyScrollRule(newVisibleList);

        // Пересчитываем высоту после смены фильтра
        setTimeout(() => adjustPopupHeight(), 100);
    } catch (error) {
        console.error('Error in filterTopics:', error);
    }
}

// Render popup
function renderPopup(data) {
    const usernameText = elements.username.querySelector('.user-name-text');
    if (usernameText) {
        usernameText.textContent = data.user_name;
    }

    const userAvatar = document.getElementById('user-avatar');
    const userIconFallback = elements.username.querySelector('.user-icon-fallback');

    if (userAvatar && data.user_avatar_url) {
        userAvatar.src = data.user_avatar_url;

        // Показываем аватар и скрываем иконку при успешной загрузке
        userAvatar.onload = function() {
            this.style.display = 'block';
            if (userIconFallback) {
                userIconFallback.style.display = 'none';
            }
        };

        // Показываем иконку если аватар не загрузился
        userAvatar.onerror = function() {
            this.style.display = 'none';
            if (userIconFallback) {
                userIconFallback.style.display = 'inline-block';
            }
        };
    }

    renderTopics(data.favorites);
    renderQMS(data.qms);
    renderMentions(data.mentions);

    setupActionButtons();
    updateStats(data);

    if (settings.default_view === 'collapsed') {
        collapsePopup();
    } else {
        filterTopics(settings.default_view);
    }

    updateLastUpdateTime();
}

// Update stats
function updateStats(data) {
    animateCounter(elements.statFavorites.querySelector('.stat-number'), data.favorites.count);
    animateCounter(elements.statQms.querySelector('.stat-number'), data.qms.count);
    animateCounter(elements.statMentions.querySelector('.stat-number'), data.mentions.count);
    // Fluid Logic 2026: breathing icon when QMS has unread
    if (elements.statQms) {
        elements.statQms.dataset.hasUnread = data.qms.count > 0 ? 'true' : 'false';
    }

    elements.statFavorites.classList.remove(CLASS_ACTIVE);
    elements.statQms.classList.remove(CLASS_ACTIVE);
    elements.statMentions.classList.remove(CLASS_ACTIVE);

    if (currentFilter === 'favorites') {
        elements.statFavorites.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'qms') {
        elements.statQms.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'mentions') {
        elements.statMentions.classList.add(CLASS_ACTIVE);
    }
}

// Render Topics list
function renderTopics(favoritesData) {
    try {
        // Используем DocumentFragment для избежания reflow
        const fragment = document.createDocumentFragment();

        if (!favoritesData || !favoritesData.list || favoritesData.list.length === 0) {
            elements.topicsList.innerHTML = '';
            return;
        }

        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let topicsToShow = favoritesData.list;
        if (!settings.show_all_favorites) {
            topicsToShow = favoritesData.list.filter(t => !t.viewed);
        }

        const unreadTopics = topicsToShow.filter(t => !t.viewed);
        const readTopics = topicsToShow.filter(t => t.viewed);

        // 🎯 Focused topics always first (within unread)
        const focusedUnread  = unreadTopics.filter(t => focusedTopics.has(String(t.id)));
        const normalUnread   = unreadTopics.filter(t => !focusedTopics.has(String(t.id)));
        const orderedUnread  = [...focusedUnread, ...normalUnread];

        orderedUnread.forEach((topic, index) => {
            const card = createTopicCard(topic, template, index, false);
            fragment.appendChild(card);
        });

        // "Сегодня" divider between unread and read
        if (orderedUnread.length > 0 && readTopics.length > 0) {
            const divider = document.createElement('li');
            divider.className = 'date-divider';
            divider.innerHTML = '<span class="date-divider-label">Сегодня</span>';
            fragment.appendChild(divider);
        }

        readTopics.forEach((topic, index) => {
            const card = createTopicCard(topic, template, index + orderedUnread.length, true);
            fragment.appendChild(card);
        });

        // Одна операция DOM - без дерганья
        elements.topicsList.innerHTML = '';
        elements.topicsList.appendChild(fragment);

        // 🎯 Toggle has-focused class — triggers micro-blur on siblings
        const anyFocused = focusedUnread.length > 0;
        elements.topicsList.classList.toggle('has-focused', anyFocused);

        // Динамически подстраиваем высоту попапа
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering topics:', error);
    }
}

// Create Topic card
function createTopicCard(topic, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `topic_${topic.id}`;
    card.dataset.id = topic.id; // Добавляем data-id для свайпов
    card.style.animationDelay = `${index * 0.05}s`;

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        // Заменяем эмодзи на SVG
        typeIcon.innerHTML = '<use href="#icon-file-text"></use>';
    }

    if (topic.pin) {
        card.classList.add(CLASS_PINNED);
        const pinIcon = card.querySelector('.topic-pin-icon');
        if (pinIcon) {
            pinIcon.classList.remove(CLASS_HIDDEN);
        }
    }

    // 🎯 Focus state
    const topicIdStr = String(topic.id);
    if (focusedTopics.has(topicIdStr)) {
        card.classList.add('focused');
    }

    // 🔕 Mute state
    if (mutedTopics.has(topicIdStr)) {
        card.classList.add('muted');
    }

    // Focus button handler
    const focusBtn = card.querySelector('.topic-focus-btn');
    if (focusBtn) {
        focusBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleTopicFocus(topic.id);
            // Update this card visually
            const isFocused = focusedTopics.has(topicIdStr);
            card.classList.toggle('focused', isFocused);
            card.classList.remove('muted'); // unmute when focusing
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.style.display = isFocused ? 'block' : '';
            const muteIcon = card.querySelector('.topic-mute-icon');
            if (muteIcon) muteIcon.style.display = '';
            // Re-sort list so focused card jumps to top
            renderTopics(currentData?.favorites);
        });
        focusBtn.title = focusedTopics.has(topicIdStr)
            ? 'Снять приоритет'
            : 'Режим концентрации: следить за темой';
    }

    // Mute button handler
    const muteBtn = card.querySelector('.topic-mute-btn');
    if (muteBtn) {
        muteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleTopicMute(topic.id);
            const isMuted = mutedTopics.has(topicIdStr);
            card.classList.toggle('muted', isMuted);
            card.classList.remove('focused'); // unfocus when muting
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.style.display = '';
        });
        muteBtn.title = mutedTopics.has(topicIdStr)
            ? 'Включить уведомления'
            : 'Тихий режим: заглушить уведомления';
    }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(topic.title);
        card.title = decodeHtmlEntities(topic.title);
    }

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl = card.querySelector('.topic-time');

        if (authorEl && topic.last_user_name) {
            authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(topic.last_user_name)}`;
        }

        if (timeEl && topic.last_post_ts) {
            timeEl.textContent = `• ${formatRelativeTime(topic.last_post_ts)}`;
        }
    }

    const badge = card.querySelector('.unread-badge');
    if (badge && topic.unread_count > 0) {
        badge.textContent = topic.unread_count;
        badge.classList.remove(CLASS_HIDDEN);
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (isRead && markReadBtn) {
        markReadBtn.remove();
    } else if (markReadBtn) {
        markReadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            markTopicAsRead(topic.id);
        });
    }

    card.addEventListener('click', () => {

        // Помечаем в данных
        if (currentData?.favorites?.list) {
            const topicInData = currentData.favorites.list.find(t => t.id === topic.id);
            if (topicInData) topicInData.viewed = true;
            const unreadCount = currentData.favorites.list.filter(t => !t.viewed).length;
            currentData.favorites.count = unreadCount;
            const favNumber = elements.statFavorites?.querySelector('.stat-number');
            if (favNumber) animateCounter(favNumber, unreadCount);
        }

        // Открываем вкладку
        openTab('favorites', { id: topic.id, view: 'getnewpost' });

        // Анимированно убираем если show_all = off
        if (!settings.show_all_favorites) {
            _animateCardRemoval(card, () => {
                // Обновляем данные и перезапускаем фильтр
                if (currentData?.favorites?.list) {
                    const t = currentData.favorites.list.find(x => x.id === topic.id);
                    if (t) t.viewed = true;
                }
                filterTopics(currentFilter || 'favorites');
            });
        }

        setTimeout(() => updateCountersFromBackground(), 600);
    });

    return clone;
}

// Format relative time
function formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин. назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч. назад`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} дн. назад`;
    return `${Math.floor(diff / 604800)} нед. назад`;
}

// Общая функция анимированного удаления карточки
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
    setTimeout(() => {
        card.remove();
        onDone?.();
    }, 390);
}

// Mark topic as read
async function markTopicAsRead(topicId) {
    try {
        const result = await sendMessage({
            action: 'mark_as_read',
            id: topicId
        });

        if (result) {
            const card = document.getElementById(`topic_${topicId}`);
            // Помечаем в данных немедленно
            if (currentData?.favorites?.list) {
                const topicInData = currentData.favorites.list.find(t => t.id === topicId);
                if (topicInData) topicInData.viewed = true;
                const unreadCount = currentData.favorites.list.filter(t => !t.viewed).length;
                currentData.favorites.count = unreadCount;
                const favNumber = elements.statFavorites?.querySelector('.stat-number');
                if (favNumber) animateCounter(favNumber, unreadCount);
                if (unreadCount === 0) elements.statFavorites?.classList.remove(CLASS_ACTIVE);
            }

            if (card) {
                _animateCardRemoval(card, () => {
                    // После удаления — перезапускаем текущий фильтр (он сам покажет empty-state)
                    filterTopics(currentFilter || 'favorites');
                });
            }
        }
    } catch (error) {
        console.error('Failed to mark topic as read:', error);
    }
}

// Render QMS list
function renderQMS(qmsData) {
    try {
        // Сбрасываем состояние загрузки при перерисовке
        loadingQmsSubjects.clear();

        // Используем DocumentFragment
        const fragment = document.createDocumentFragment();

        if (!qmsData || !qmsData.list || qmsData.list.length === 0) {
            elements.qmsList.innerHTML = '';
            return;
        }


        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let dialogsToShow = qmsData.list;
        if (!settings.show_all_qms) {
            dialogsToShow = qmsData.list.filter(d => d.unread && !d.viewed);
        }

        const unreadDialogs = dialogsToShow.filter(d => d.unread && !d.viewed);
        const readDialogs = dialogsToShow.filter(d => !d.unread || d.viewed);


        unreadDialogs.forEach((dialog, index) => {
            const card = createQMSCard(dialog, template, index, false);
            fragment.appendChild(card);
        });

        readDialogs.forEach((dialog, index) => {
            const card = createQMSCard(dialog, template, index + unreadDialogs.length, true);
            fragment.appendChild(card);
        });

        // Одна операция DOM
        elements.qmsList.innerHTML = '';
        elements.qmsList.appendChild(fragment);


        setupQMSLazyLoading();

        // Динамически подстраиваем высоту попапа
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering QMS:', error);
    }
}

// Create QMS card with INLINE REPLY functionality
function createQMSCard(dialog, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `qms_${dialog.id}`;
    card.style.animationDelay = `${index * 0.05}s`;

    card.setAttribute('data-opponent-name', dialog.opponent_name || '');
    card.setAttribute('data-opponent-id', dialog.opponent_id || '');
    card.setAttribute('data-dialog-id', dialog.id || '');

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        typeIcon.innerHTML = '<use href="#icon-mail"></use>';
    }

    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) {
        pinIcon.classList.add(CLASS_HIDDEN);
    }

    const titleEl = card.querySelector('.topic-title');
    const metaEl = card.querySelector('.topic-meta');

    // Приоритет: subject > title > opponent_name
    const dialogTitle = dialog.subject || dialog.title || dialog.opponent_name;

    // Мета: всегда показываем имя отправителя + время
    let dialogMeta = decodeHtmlEntities(dialog.opponent_name || '');
    if (dialog.last_msg_ts) {
        dialogMeta += (dialogMeta ? ' • ' : '') + formatRelativeTime(dialog.last_msg_ts);
    }

    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(dialogTitle);
        card.title = decodeHtmlEntities(dialogTitle);
    }

    if (metaEl) {
        while (metaEl.firstChild) {
            metaEl.removeChild(metaEl.firstChild);
        }
        if (dialogMeta) {
            metaEl.appendChild(document.createTextNode(dialogMeta));
        }
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) {
        markReadBtn.remove();
    }

    // QMS cards don't use focus/mute — remove those template buttons
    card.querySelector('.topic-focus-btn')?.remove();
    card.querySelector('.topic-mute-btn')?.remove();
    card.querySelector('.topic-focus-icon')?.remove();
    card.querySelector('.topic-mute-icon')?.remove();

    // =======================================================
    // ИНТЕГРАЦИЯ INLINE-ЧАТА
    // =======================================================

    const cardBody = card.querySelector('.card-body');

    // 1. Создаем DOM элементы для инлайн-чата
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
        </div>
    `;

    // 2. Вставляем элементы в карточку
    cardBody.appendChild(inlineChat);

    // Блокируем всплытие клика, чтобы интерфейс чата не дергал саму карточку
    inlineChat.addEventListener('click', e => e.stopPropagation());

    // 3. Наполняем панель смайликов
    const EMOJIS = ['😀','😂','🤣','😊','😍','😒','😘','😁','😉','😎','😋','😜','🤔','🙄','😏','😔','😴','🤤','😷','🤢','🤮','🤧','😵','🤯','🤠','🥳','🤓','👍','👎','👏','🤝','🍻','🔥','❤️','💔','💯','🤷‍♂️','🤦‍♂️'];
    const emojiPicker = inlineChat.querySelector('.qms-emoji-picker');
    const textarea = inlineChat.querySelector('.qms-textarea');

    EMOJIS.forEach(emo => {
        const span = document.createElement('span');
        span.textContent = emo;
        span.className = 'qms-emoji-item';
        span.onclick = (e) => {
            e.stopPropagation();
            // Вставляем смайлик туда, где стоит курсор
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + emo + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + emo.length;
            textarea.focus();
        };
        emojiPicker.appendChild(span);
    });

    // 4. Добавляем кнопку "Открыть вкладку" в панель действий карточки
    const actionsContainer = card.querySelector('.card-actions');
    const openTabBtn = document.createElement('button');
    openTabBtn.className = 'action-icon open-tab interactive';
    openTabBtn.title = 'Открыть диалог в новой вкладке';
    openTabBtn.innerHTML = '<svg class="icon"><use href="#icon-external-link"></use></svg>';
    openTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id });
    });
    actionsContainer.appendChild(openTabBtn);

    // 5. Логика раскрытия карточки по клику
    let isExpanded = false;
    let lastMessageId = '0';

    card.addEventListener('click', async (e) => {
        // Игнорируем клики по кнопкам действий (например, открыть вкладку)
        if (e.target.closest('.card-actions')) return;

        // Если уже открыта — сворачиваем
        if (isExpanded) {
            isExpanded = false;
            inlineChat.classList.add('hidden');
            adjustPopupHeight();
            return;
        }

        // Открываем чат
        isExpanded = true;
        inlineChat.classList.remove('hidden');
        adjustPopupHeight();

        const historyContainer = inlineChat.querySelector('.qms-history');
        historyContainer.innerHTML = '<div class="qms-loading-text">Загрузка истории...</div>';

        try {
            // Запрашиваем историю ПРЯМО СО СТРАНИЦЫ ДИАЛОГА (надежнее, чем XHR)
            const threadUrl = `https://4pda.to/forum/index.php?act=qms&mid=${dialog.opponent_id}&t=${dialog.id}`;
            const res = await fetch(threadUrl);
            if (!res.ok) throw new Error('Ошибка HTTP: ' + res.status);

            // Читаем страницу в бинарном виде и жестко декодируем из windows-1251
            const buffer = await res.arrayBuffer();
            const decoder = new TextDecoder('windows-1251');
            const html = decoder.decode(buffer);

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Ищем все сообщения в загруженном диалоге
            const messages = doc.querySelectorAll('#scroll-thread .list-group-item[data-message-id]');

            historyContainer.innerHTML = '';
            if (messages.length === 0) {
                 historyContainer.innerHTML = '<div class="qms-loading-text">Нет сообщений</div>';
            }

            messages.forEach(msg => {
                const msgId = msg.getAttribute('data-message-id');
                if (msgId) lastMessageId = msgId;

                const content = msg.querySelector('.msg-content');
                if (content) {
                    const msgDiv = document.createElement('div');
                    msgDiv.className = msg.classList.contains('our-message') ? 'qms-msg out' : 'qms-msg in';
                    msgDiv.innerHTML = content.innerHTML;
                    historyContainer.appendChild(msgDiv);
                }
            });

            // Прокрутка вниз И ПРИНУДИТЕЛЬНЫЙ ПЕРЕРАСЧЕТ ВЫСОТЫ ОКНА
            setTimeout(() => {
                historyContainer.scrollTop = historyContainer.scrollHeight;
                adjustPopupHeight();
            }, 50);

        } catch (err) {
            console.error("QMS History Error:", err);
            historyContainer.innerHTML = '<div class="qms-loading-text">Ошибка загрузки</div>';
            adjustPopupHeight(); // И здесь тоже на случай ошибки
        }
    });

    // 6. Кнопки внутри чата (Свернуть, Смайлики, Отправка)
    const btnCancel = inlineChat.querySelector('.qms-btn-cancel');
    const btnEmoji = inlineChat.querySelector('.qms-btn-emoji');
    const btnSend = inlineChat.querySelector('.qms-btn-send');

    btnCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        isExpanded = false;
        inlineChat.classList.add('hidden');
        adjustPopupHeight();
    });

    btnEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        emojiPicker.classList.toggle('hidden');
        adjustPopupHeight(); // Пересчитываем высоту окна
    });

    const sendHandler = async (e) => {
        if (e) e.stopPropagation();
        const text = textarea.value.trim();
        if (!text) return;

        btnSend.disabled = true;
        btnSend.textContent = '...';

        try {
            await qmsApiRequest('send-message', dialog.opponent_id, dialog.id, {
                'message': text,
                'forward-messages-username': '',
                'forward-thread-username': '',
                'attaches': '',
                'after-message': lastMessageId
            });

            // Отправка успешна!
            // Помечаем диалог прочитанным и прячем карточку (или визуально меняем)
            if (currentData?.qms?.list) {
                const dialogInData = currentData.qms.list.find(d => d.id === dialog.id);
                if (dialogInData) dialogInData.viewed = true;
                currentData.qms.count = Math.max(0, currentData.qms.count - 1);
            }

            const qmsNumber = elements.statQms?.querySelector('.stat-number');
            if (qmsNumber && currentData) animateCounter(qmsNumber, currentData.qms.count);

            if (!settings.show_all_qms) {
                _animateCardRemoval(card, () => {
                    if (currentData?.qms?.list) {
                        const d = currentData.qms.list.find(x => x.id === dialog.id);
                        if (d) d.viewed = true;
                    }
                    filterTopics(currentFilter || 'qms');
                });
            } else {
                // Если режим "показывать все", просто сворачиваем и красим в прочитанное
                isExpanded = false;
                inlineChat.classList.add('hidden');
                card.classList.remove(CLASS_UNREAD);
                card.classList.add(CLASS_READ);
                adjustPopupHeight();
            }

            setTimeout(() => updateCountersFromBackground(), 600);

        } catch (err) {
            console.error(err);
            btnSend.disabled = false;
            btnSend.textContent = 'Ошибка!';
            setTimeout(() => btnSend.textContent = 'Отправить', 2000);
        }
    };

    btnSend.addEventListener('click', sendHandler);

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendHandler();
        }
    });

    return clone;
}

// Decode HTML entities
function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

// Render Mentions list
function renderMentions(mentionsData) {
    try {
        // Используем DocumentFragment
        const fragment = document.createDocumentFragment();

        if (!mentionsData || !mentionsData.list || mentionsData.list.length === 0) {
            elements.mentionsList.innerHTML = '';
            return;
        }

        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let mentionsToShow = mentionsData.list;
        if (!settings.show_all_mentions) {
            mentionsToShow = mentionsData.list.filter(m => m.unread && !m.viewed);
        }

        const unreadMentions = mentionsToShow.filter(m => m.unread && !m.viewed);
        const readMentions = mentionsToShow.filter(m => !m.unread || m.viewed);

        unreadMentions.forEach((mention, index) => {
            const card = createMentionCard(mention, template, index, false);
            fragment.appendChild(card);
        });

        readMentions.forEach((mention, index) => {
            const card = createMentionCard(mention, template, index + unreadMentions.length, true);
            fragment.appendChild(card);
        });

        // Одна операция DOM
        elements.mentionsList.innerHTML = '';
        elements.mentionsList.appendChild(fragment);

        // Динамически подстраиваем высоту попапа
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering mentions:', error);
    }
}

// Create Mention card
function createMentionCard(mention, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `mention_${mention.id}`;
    card.style.animationDelay = `${index * 0.05}s`;

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        typeIcon.innerHTML = '<use href="#icon-message"></use>';
    }

    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) {
        pinIcon.classList.add(CLASS_HIDDEN);
    }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(mention.title);
        card.title = decodeHtmlEntities(mention.title);
    }

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl = card.querySelector('.topic-time');

        if (authorEl && mention.poster_name) {
            authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(mention.poster_name)}`;
        }

        if (timeEl && mention.timestamp) {
            timeEl.textContent = `• ${formatRelativeTime(mention.timestamp)}`;
        }
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) {
        markReadBtn.remove();
    }

    card.addEventListener('click', () => {

        card.classList.add(CLASS_READ);
        card.classList.remove(CLASS_UNREAD);

        if (currentData && currentData.mentions && currentData.mentions.list) {
            const mentionInData = currentData.mentions.list.find(m => m.id === mention.id);
            if (mentionInData) {
                mentionInData.viewed = true;
                mentionInData.unread = false;
            }

            currentData.mentions.count = Math.max(0, currentData.mentions.count - 1);
        }

        const mentNumber = elements.statMentions?.querySelector('.stat-number');
        if (mentNumber && currentData) {
            animateCounter(mentNumber, currentData.mentions.count);
        }

        openTab('mentions', {
            topic_id: mention.topic_id,
            post_id: mention.post_id
        });

        setTimeout(() => {
            updateCountersFromBackground();
        }, 400);
    });

    return clone;
}

// 🆕 Setup Intersection Observer for lazy loading QMS subjects
function setupQMSLazyLoading() {
    if (qmsObserver) {
        qmsObserver.disconnect();
    }

    qmsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const card = entry.target;
                const dialogId = card.getAttribute('data-dialog-id');

                if (!dialogId) return;

                if (!loadingQmsSubjects.has(dialogId)) {
                    // Загружаем только если тема ещё не была загружена
                    const alreadyLoaded = card.hasAttribute('data-subject-loaded');
                    if (!alreadyLoaded) {
                        fetchQMSSubject(dialogId);
                    }
                }
            }
        });
    }, {
        root: elements.main,
        rootMargin: '50px',
        threshold: 0.1
    });

    const qmsCards = elements.qmsList.querySelectorAll('.topic-card');
    qmsCards.forEach(card => qmsObserver.observe(card));
}

// 🆕 Fetch QMS subject for a specific dialog
async function fetchQMSSubject(dialogId) {
    if (loadingQmsSubjects.has(dialogId)) {
        return;
    }

    loadingQmsSubjects.add(dialogId);

    try {

        const card = document.getElementById(`qms_${dialogId}`);
        if (!card) {
            console.warn(`⚠️ Card not found for dialog: ${dialogId}`);
            return;
        }

        const opponentName = card.getAttribute('data-opponent-name');
        const opponentId = card.getAttribute('data-opponent-id');

        if (!opponentId) {
            console.warn(`⚠️ No opponent ID for dialog: ${dialogId}`);
            return;
        }

        const result = await sendMessage({
            action: 'fetch_qms_subject',
            opponent_id: opponentId
        });

        const cardNow = document.getElementById(`qms_${dialogId}`);
        if (!cardNow) {
            console.warn(`⚠️ Card disappeared during fetch for dialog: ${dialogId}`);
            return;
        }

        if (result && result.subject) {
            const titleEl = cardNow.querySelector('.topic-title');
            const metaEl = cardNow.querySelector('.topic-meta');

            if (titleEl && metaEl) {
                // Обновляем заголовок на subject
                titleEl.textContent = decodeHtmlEntities(result.subject);
                cardNow.title = decodeHtmlEntities(result.subject);
                cardNow.setAttribute('data-subject-loaded', '1');

                // Обновляем мету: показываем автора и время
                let metaText = decodeHtmlEntities(opponentName);
                if (result.last_msg_ts) {
                    metaText += ` • ${formatRelativeTime(result.last_msg_ts)}`;
                }
                metaEl.textContent = metaText;

            }

            if (currentData && currentData.qms && currentData.qms.list && result.dialogId) {
                const dialog = currentData.qms.list.find(d => d.opponent_id == opponentId);
                if (dialog) {
                    dialog.id = result.dialogId;
                    dialog.subject = result.subject;
                    dialog.subject_loaded = true;
                    if (result.last_msg_ts) {
                        dialog.last_msg_ts = result.last_msg_ts;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to fetch QMS subject for ${dialogId}:`, error);
    } finally {
        loadingQmsSubjects.delete(dialogId);
    }
}

// Refresh data from background
async function refreshData() {
    const previousFilter = currentFilter;

    showLoading(true);

    try {
        await sendMessage({ action: 'force_update' });

        const response = await sendMessage({ action: 'popup_loaded' });
        if (response) {
            currentData = response;

            settings.simple_list = response.settings.toolbar_simple_list;
            settings.close_on_open = response.settings.toolbar_open_theme_hide;
            settings.default_view = response.settings.toolbar_default_view || 'collapsed';
            settings.show_all_favorites = response.settings.show_all_favorites || false;
            settings.show_all_qms = response.settings.show_all_qms || false;
            settings.show_all_mentions = response.settings.show_all_mentions || false;
            settings.bw_icons = response.settings.bw_icons || false;
            settings.accent_color = response.settings.accent_color || 'purple';

            if (settings.bw_icons) {
                document.body.classList.add('bw-icons');
            } else {
                document.body.classList.remove('bw-icons');
            }

            document.body.setAttribute('data-accent', settings.accent_color);

            renderTopics(response.favorites);
            renderQMS(response.qms);
            renderMentions(response.mentions);

            setupActionButtons();

            const usernameText = elements.username.querySelector('.user-name-text');
            if (usernameText) {
                usernameText.textContent = response.user_name;
            }

            updateStats(response);

            if (previousFilter) {
                filterTopics(previousFilter);
            } else {
                collapsePopup();
            }

            updateLastUpdateTime();
        }
    } catch (error) {
        console.error('Failed to refresh data:', error);
    } finally {
        showLoading(false);
    }
}

// Open tab helper
function openTab(what, options = {}) {
    const finalMessage = {
        action: 'open_url',
        what: what,
        ...options
    };


    try {
        chrome.runtime.sendMessage(finalMessage);

        setTimeout(() => {
            if (settings.close_on_open) {
                window.close();
            } else {
            }
        }, 100);
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}

// Create port for batch operations
function createPort(name) {
    const port = chrome.runtime.connect({ name: name });

    port.onMessage.addListener((msg) => {
        const card = document.getElementById(`topic_${msg.id}`);
        if (card) {
            card.classList.add(CLASS_READ);
        }

        const favNumber = elements.statFavorites.querySelector('.stat-number');
        if (favNumber) {
            animateCounter(favNumber, msg.count);
        }

        if (msg.count === 0) {
            elements.statFavorites.classList.remove(CLASS_ACTIVE);
            showEmptyState(true);
        }
    });

    port.onDisconnect.addListener(() => {
        // Port disconnected - this is normal
    });

    return port;
}

// ✨ Update counters from background (polling)
async function updateCountersFromBackground() {
    try {
        const counts = await sendMessage({ action: 'get_counts' });
        if (counts && currentData) {
            currentData.favorites.count = counts.favorites;
            currentData.qms.count = counts.qms;
            currentData.mentions.count = counts.mentions;

            const favNumber = elements.statFavorites?.querySelector('.stat-number');
            if (favNumber) animateCounter(favNumber, counts.favorites);

            const qmsNumber = elements.statQms?.querySelector('.stat-number');
            if (qmsNumber) animateCounter(qmsNumber, counts.qms);

            const mentNumber = elements.statMentions?.querySelector('.stat-number');
            if (mentNumber) animateCounter(mentNumber, counts.mentions);


            // Если текущий фильтр показывает пустой список — сразу показываем empty state
            _checkAndShowEmptyState();
        }
    } catch (error) {
        console.error('Failed to update counters:', error);
    }
}

// Проверяет виден ли реальный список и показывает empty-state если пуст
function _checkAndShowEmptyState() {
    if (!currentData || !currentFilter) return;

    const visibleList = elements.main?.querySelector('.topics-list:not(.hidden)');
    const remainingCards = visibleList
        ? visibleList.querySelectorAll('.topic-card:not([style*="opacity: 0"])').length
        : 0;

    if (remainingCards > 0) return; // ещё есть карточки — ничего не делаем

    if (currentFilter === 'favorites') {
        const hasUnread = currentData.favorites.list?.some(t => !t.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Все темы прочитаны');
            elements.statFavorites?.classList.remove(CLASS_ACTIVE);
        }
    } else if (currentFilter === 'qms') {
        const hasUnread = currentData.qms.list?.some(d => d.unread && !d.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Нет новых сообщений');
            elements.statQms?.classList.remove(CLASS_ACTIVE);
        }
    } else if (currentFilter === 'mentions') {
        const hasUnread = currentData.mentions.list?.some(m => m.unread && !m.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Нет новых ответов');
            elements.statMentions?.classList.remove(CLASS_ACTIVE);
        }
    }
}

// ===================================
// AUTO-MODE POLLING
// Строгие правила:
//  - Один и только один активный интервал
//  - Интервал живёт независимо от UI
//  - Восстанавливается из storage при открытии popup
//  - clearInterval перед любым новым созданием
// ===================================

const AUTO_POLL_INTERVAL_MS = 60_000; // 60 секунд — строго фиксированный

/**
 * Запустить авторежим.
 * Защита от дублей: перед созданием нового интервала старый уничтожается.
 */
function startPolling() {
    // Уничтожаем старый интервал, если вдруг есть
    if (pollInterval) {
        console.warn('⚠️ startPolling: interval already exists, clearing first');
        clearInterval(pollInterval);
        pollInterval = null;
    }

    // Не запускаем polling, если popup закрывается сразу при открытии ссылок
    if (settings.close_on_open) {
        return;
    }


    // Сохраняем состояние авторежима в storage
    chrome.storage.local.set({ auto_mode_active: true });

    pollInterval = setInterval(() => {
        updateCountersFromBackground();
    }, AUTO_POLL_INTERVAL_MS);
}

/**
 * Остановить авторежим.
 * clearInterval — обязателен, таймер полностью уничтожается.
 */
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    chrome.storage.local.set({ auto_mode_active: false });
}

/**
 * Восстановить авторежим из storage (вызывается при открытии popup).
 * Если авторежим был включён до закрытия браузера — восстанавливаем.
 */
async function restoreAutoModeIfNeeded() {
    try {
        const stored = await chrome.storage.local.get(['auto_mode_active']);
        if (stored.auto_mode_active && !pollInterval) {
            startPolling();
        }
    } catch (err) {
        console.error('restoreAutoModeIfNeeded error:', err);
    }
}

// ✨ Cleanup on window unload — только уничтожаем интервал popup,
//    НЕ трогаем auto_mode_active в storage (фоновый цикл продолжает работать)
window.addEventListener('beforeunload', () => {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
});

// Handle refresh button click
async function handleRefreshClick() {
    elements.refresh.classList.add('spinning');

    try {
        await refreshData();
    } finally {
        setTimeout(() => {
            elements.refresh.classList.remove('spinning');
        }, 600);
    }
}

// Show/hide loading skeleton
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

// Show empty state
function showEmptyState(show, customMessage = null) {
    if (show) {
        if (customMessage) {
            elements.emptyTitle.textContent = customMessage;
        }
        showElement(elements.emptyState);
        hideElement(elements.topicsList);
        hideElement(elements.qmsList);
        hideElement(elements.mentionsList);
    } else {
        hideElement(elements.emptyState);
    }
}

// Update last update time
function updateLastUpdateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });

    if (elements.lastUpdateTime) {
        elements.lastUpdateTime.textContent = timeString;
    }
}

// Helper functions
function showElement(element) {
    if (element) {
        element.classList.remove(CLASS_HIDDEN);
    }
}

function hideElement(element) {
    if (element) {
        element.classList.add(CLASS_HIDDEN);
    }
}

// Send message to background
function sendMessage(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Runtime error:', chrome.runtime.lastError.message);
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        } catch (error) {
            console.error('Send message error:', error);
            reject(error);
        }
    });
}

/* ═══════════════════════════════════════════════════════════
   FONT SETTINGS APPLICATION
   ═══════════════════════════════════════════════════════════ */

// Карта шрифтов
// Шрифты загружаются динамически только если пользователь выбрал конкретный шрифт
const GOOGLE_FONTS = {
    'inter':        'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'roboto':       'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'open-sans':    'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'pt-sans':      'https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap',
    'ubuntu':       'https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'noto-sans':    'https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'source-sans':  'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&display=swap',
    'comfortaa':    'https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;400;700&display=swap',
    'nunito':       'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'manrope':      'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap',
    'rubik':        'https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'montserrat':   'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'jetbrains-mono':'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'bricolage':     'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700&display=swap',
    'onest':         'https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&display=swap',
    'geologica':     'https://fonts.googleapis.com/css2?family=Geologica:slnt,wght@0,300;0,400;0,500;0,600;0,700&display=swap',
};

let _loadedFontUrl = null;
function _loadGoogleFont(family) {
    const url = GOOGLE_FONTS[family];
    if (!url || _loadedFontUrl === url) return;
    const existing = document.getElementById('dynamic-gfont');
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id = 'dynamic-gfont';
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
    _loadedFontUrl = url;
}

const FONT_FAMILIES = {
    'system': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'inter': '"Inter", -apple-system, sans-serif',
    'roboto': '"Roboto", -apple-system, sans-serif',
    'open-sans': '"Open Sans", -apple-system, sans-serif',
    'pt-sans': '"PT Sans", -apple-system, sans-serif',
    'ubuntu': 'Ubuntu, -apple-system, sans-serif',
    'noto-sans': '"Noto Sans", -apple-system, sans-serif',
    'source-sans': '"Source Sans Pro", -apple-system, sans-serif',
    'verdana': 'Verdana, Geneva, sans-serif',
    'comfortaa': '"Comfortaa", cursive, -apple-system, sans-serif',
    'nunito': '"Nunito", -apple-system, sans-serif',
    'manrope': '"Manrope", -apple-system, sans-serif',
    'rubik': '"Rubik", -apple-system, sans-serif',
    'montserrat': '"Montserrat", -apple-system, sans-serif',
    'jetbrains-mono': '"JetBrains Mono", "Courier New", monospace, -apple-system, sans-serif',
    'bricolage':      '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':          '"Onest", -apple-system, sans-serif',
    'geologica':      '"Geologica", -apple-system, sans-serif'
};

const FONT_SIZES = {
    xs: '12px',
    small: '14px',
    medium: '16px',
    large: '18px',
    xl: '20px',
    xxl: '22px'
};

// Применение настроек шрифта
async function applyFontSettings() {
    const data = await chrome.storage.local.get(['font_family', 'font_size', 'line_height', 'compact_mode']);

    const root = document.documentElement;

    if (data.font_family && FONT_FAMILIES[data.font_family]) {
        _loadGoogleFont(data.font_family);
        const fontVal = FONT_FAMILIES[data.font_family];
        // Use !important so it overrides any CSS including Inter Tight default
        document.body.style.setProperty('font-family', fontVal, 'important');
        // Also force on elements that may resist inheritance
        document.querySelectorAll(
            '.time-clock, .time-date, #current-date, #current-time, ' +
            '.user-name-text, .topic-title, .topic-meta, .stat-number, .stat-label, ' +
            '.action-btn, header, main'
        ).forEach(el => {
            el.style.setProperty('font-family', fontVal, 'important');
        });
    }

    if (data.font_size && FONT_SIZES[data.font_size]) {
        let baseFontSize = parseInt(FONT_SIZES[data.font_size]);

        // В компактном режиме ограничиваем максимальный размер до 18px (L)
        const isCompactMode = document.body.classList.contains('compact-mode');
        if (isCompactMode && baseFontSize > 18) {
            baseFontSize = 18;
        }

        // Пересчитываем все размеры пропорционально базовому
        root.style.setProperty('--font-xs', `${baseFontSize - 6}px`);
        root.style.setProperty('--font-sm', `${baseFontSize - 4}px`);
        root.style.setProperty('--font-md', `${baseFontSize - 3}px`);
        root.style.setProperty('--font-lg', `${baseFontSize - 2}px`);
        root.style.setProperty('--font-xl', `${baseFontSize}px`);
    }

    if (data.line_height) {
        document.body.style.lineHeight = data.line_height;
    }
}

/* ═══════════════════════════════════════════════════════════
   THEME AND ACCENT COLOR APPLICATION
   ═══════════════════════════════════════════════════════════ */

// Применение темы и цветов
async function applyThemeAndColors() {
    const data = await chrome.storage.local.get(['theme_mode', 'accent_color']);

    // Применяем тему
    const theme = data.theme_mode || 'liquid-glass';
    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');

        // Слушаем изменения системной темы
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            chrome.storage.local.get(['theme_mode'], (data) => {
                if (data.theme_mode === 'auto') {
                    document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                }
            });
        });
    } else {
        document.body.setAttribute('data-theme', theme);
    }

    // Применяем цвет акцента
    let accent = data.accent_color || 'purple';
    if (accent === 'green') accent = 'teal';
    if (accent === 'pink' || accent === 'red') accent = 'blue';
    document.body.setAttribute('data-accent', accent);

    // Re-apply fonts after theme change — inline styles may get reset
    setTimeout(() => applyFontSettings(), 50);
}

// Применение только настроек темы (для динамического обновления)
async function applyThemeSettings() {
    const data = await chrome.storage.local.get(['theme_mode']);
    const theme = data.theme_mode || 'liquid-glass';

    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
        document.body.setAttribute('data-theme', theme);
    }
}

// ===================================
// COMPACT MODE
// ===================================
function toggleCompactMode() {
    settings.compact_mode = !settings.compact_mode;

    document.body.classList.toggle('compact-mode', settings.compact_mode);
    document.getElementById('compact-toggle')?.classList.toggle('active', settings.compact_mode);

    // Сохраняем настройку
    chrome.storage.local.set({ compact_mode: settings.compact_mode }, () => {
    });

    // Пересчитываем шрифты с учетом ограничения в компактном режиме
    applyFontSettings();

    // Пересчитываем высоту и правило скролла после изменения режима
    setTimeout(() => {
        // Применяем правило скролла к видимому списку
        const visibleList = document.querySelector('main .topics-list:not(.hidden)');
        if (visibleList) applyScrollRule(visibleList);
        adjustPopupHeight();
    }, 250);
}

// ===================================
// DYNAMIC POPUP HEIGHT
// ===================================

// Порог: скролл появляется только когда тем СТРОГО больше этого числа
// При ≤ SCROLL_THRESHOLD тем — высота по контенту, скролла нет
const SCROLL_THRESHOLD  = 4;  // скролл при 5+
// Сколько карточек видно без скролла — по высоте этих карточек фиксируется попап
const MAX_CARDS_VISIBLE = 6;  // видно 6 тем, остальные скроллятся
const MAX_POPUP_HEIGHT   = 600;

let adjustHeightTimeout = null;

/**
 * Применяет правило скролла к списку:
 * items > SCROLL_THRESHOLD → overflow-y: auto, фиксированная высота
 * items ≤ SCROLL_THRESHOLD → overflow-y: hidden, высота по контенту
 * Работает одинаково в compact и normal режиме.
 */
function applyScrollRule(listEl) {
    if (!listEl) return;
    const itemCount = listEl.querySelectorAll('.topic-card').length;
    if (itemCount > SCROLL_THRESHOLD) {
        listEl.style.overflowY = 'auto';
    } else {
        listEl.style.overflowY = 'hidden';
        listEl.style.maxHeight  = '';    // снимаем ограничение — высота по контенту
    }
}

function adjustPopupHeight() {
    // Debounce
    if (adjustHeightTimeout) clearTimeout(adjustHeightTimeout);

    adjustHeightTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
            const header   = document.querySelector('header');
            const main     = document.querySelector('main');
            const radioBar = document.getElementById('mini-radio-bar');
            const radioBarH = (radioBar && radioBar.style.display !== 'none') ? radioBar.offsetHeight : 0;

            if (!header || !main || main.classList.contains('hidden')) {
                const headerHeight = header ? header.offsetHeight : 200;
                document.body.style.height    = `${headerHeight + radioBarH + 10}px`;
                document.body.style.minHeight = `${headerHeight + radioBarH + 10}px`;
                return;
            }

            // --- Считаем DOM-элементы списка, а НЕ высоту ---
                const visibleList = main.querySelector('.topics-list:not(.hidden)');
                const visibleCards = visibleList
                    ? visibleList.querySelectorAll('.topic-card')
                    : main.querySelectorAll('.topic-card');
                const cardCount = visibleCards.length;


                // Применяем правило скролла к видимому списку
                if (visibleList) applyScrollRule(visibleList);

                if (cardCount === 0) {
                    // Пустое состояние
                    const emptyState  = document.getElementById('empty-state');
                    const headerH     = header.offsetHeight;
                    const emptyH      = emptyState && !emptyState.classList.contains('hidden')
                        ? emptyState.offsetHeight : 250;
                    const totalH      = headerH + radioBarH + emptyH + 20;
                    document.body.style.height    = `${totalH}px`;
                    document.body.style.minHeight = `${totalH}px`;
                    main.style.maxHeight = 'none';
                    return;
                }

                const headerH = header.offsetHeight;
                const gap     = visibleList
                    ? parseInt(window.getComputedStyle(visibleList).gap) || 6 : 6;
                const mainCS  = window.getComputedStyle(main);
                const mainPad = (parseInt(mainCS.paddingTop) || 8)
                              + (parseInt(mainCS.paddingBottom) || 8);

                // Высота всех карточек
                let totalCardsH = 0;
                visibleCards.forEach(c => { totalCardsH += c.offsetHeight; });
                const gapTotal   = Math.max(0, (cardCount - 1) * gap);
                const contentH   = totalCardsH + gapTotal + mainPad;

                if (cardCount <= SCROLL_THRESHOLD) {
                    // ≤ 2 тем: высота по контенту, никакого скролла
                    const totalH  = headerH + radioBarH + contentH;
                    const finalH  = Math.min(totalH, MAX_POPUP_HEIGHT);
                    document.body.style.height    = `${finalH}px`;
                    document.body.style.minHeight = `${finalH}px`;
                    main.style.maxHeight = 'none';
                    main.style.overflowY = 'hidden';
                } else if (cardCount <= MAX_CARDS_VISIBLE) {
                    // 3–6 тем: показываем все, скролл включён (по правилу > 2)
                    const totalH  = headerH + radioBarH + contentH;
                    const finalH  = Math.min(totalH, MAX_POPUP_HEIGHT);
                    document.body.style.height    = `${finalH}px`;
                    document.body.style.minHeight = `${finalH}px`;
                    main.style.maxHeight = `${contentH}px`;
                    main.style.overflowY = 'auto';
                } else {
                    // > MAX_CARDS_VISIBLE тем: фиксированная высота со скроллом
                    let maxCardsH = 0;
                    for (let i = 0; i < Math.min(MAX_CARDS_VISIBLE, visibleCards.length); i++) {
                        maxCardsH += visibleCards[i].offsetHeight;
                    }
                    const maxGapTotal  = (MAX_CARDS_VISIBLE - 1) * gap;
                    const maxContentH  = maxCardsH + maxGapTotal + mainPad;
                    const totalH       = headerH + radioBarH + maxContentH;
                    const finalH       = Math.min(totalH, MAX_POPUP_HEIGHT);
                    document.body.style.height    = `${finalH}px`;
                    document.body.style.minHeight = `${finalH}px`;
                    main.style.maxHeight = `${maxContentH}px`;
                    main.style.overflowY = 'auto';
                }
        });
    }, 30);
}
// ══════════════════════════════════════════════
// 4Pulse i18n — popup translations
// ══════════════════════════════════════════════
const POPUP_TRANSLATIONS = {
    ru: { popup_stats:'Статистика', popup_topics:'Темы', popup_mentions:'Ответы', popup_open_all:'Открыть все', popup_pinned:'Закреплённые', popup_read_all:'Прочитать все', popup_empty:'Непрочитанных тем нет', popup_last_update:'Последнее обновление:', radio_mini_radio:'🎵 Радио' },
    en: { popup_stats:'Stats', popup_topics:'Topics', popup_mentions:'Mentions', popup_open_all:'Open all', popup_pinned:'Pinned', popup_read_all:'Read all', popup_empty:'No unread topics', popup_last_update:'Last update:', radio_mini_radio:'🎵 Radio' },
    de: { popup_stats:'Statistik', popup_topics:'Themen', popup_mentions:'Erwähnungen', popup_open_all:'Alle öffnen', popup_pinned:'Angeheftet', popup_read_all:'Alle gelesen', popup_empty:'Keine ungelesenen Themen', popup_last_update:'Letzte Aktualisierung:', radio_mini_radio:'🎵 Radio' },
    uk: { popup_stats:'Статистика', popup_topics:'Теми', popup_mentions:'Відповіді', popup_open_all:'Відкрити всі', popup_pinned:'Закріплені', popup_read_all:'Прочитати всі', popup_empty:'Непрочитаних тем немає', popup_last_update:'Останнє оновлення:', radio_mini_radio:'🎵 Радіо' },
};

async function applyPopupLanguage() {
    try {
        const result = await chrome.storage.local.get(['ui_language']);
        const lang = result.ui_language || 'ru';
        const t = POPUP_TRANSLATIONS[lang] || POPUP_TRANSLATIONS['ru'];

        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (t[key]) el.textContent = t[key];
        });

        // Last-update label has a <span> inside — preserve it
        const luEl = document.querySelector('[data-i18n-prefix="popup_last_update"]');
        if (luEl && t['popup_last_update']) {
            const span = luEl.querySelector('#last-update-time');
            if (span) {
                luEl.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = t['popup_last_update'] + ' '; });
            }
        }
    } catch(e) { console.warn('i18n:', e); }
}

document.addEventListener('DOMContentLoaded', () => setTimeout(applyPopupLanguage, 50));

// Re-run clock date when language changes (storage event from options page)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.ui_language) {
        applyPopupLanguage();
        // Re-render date with new language
        const dateEl = document.getElementById('current-date');
        if (dateEl) {
            const MONTHS = {
                ru: ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'],
                en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
                de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
                uk: ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'],
            };
            const lang = changes.ui_language.newValue || 'ru';
            const now = new Date();
            const months = MONTHS[lang] || MONTHS['ru'];
            dateEl.textContent = lang === 'de'
                ? `${now.getDate()}. ${months[now.getMonth()]}`
                : `${now.getDate()} ${months[now.getMonth()]}`;
        }
    }
    // 🎵 Radio enabled/disabled externally
    if (changes.radio_enabled) {
        const bar = document.getElementById('mini-radio-bar');
        if (bar) {
            if (changes.radio_enabled.newValue) {
                bar.style.display = 'flex';
                initMiniRadio();
            } else {
                bar.style.display = 'none';
            }
        }
    }
});


// =======================================================
// QMS API ЗАПРОСЫ (БЫСТРЫЙ ОТВЕТ)
// =======================================================
async function qmsApiRequest(action, mid, t, additionalData = {}) {
    const url = 'https://4pda.to/forum/index.php?act=qms-xhr';
    const formData = new FormData();
    formData.append('action', action);
    formData.append('mid', mid);
    formData.append('t', t);

    for (const [key, value] of Object.entries(additionalData)) {
        formData.append(key, value);
    }

    const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

    const text = await response.text(); // Получаем ответ как текст

    try {
        return JSON.parse(text); // Пытаемся распарсить как JSON (для отправки)
    } catch (e) {
        return { html: text };   // Если сервер вернул голый HTML (для истории и предпросмотра)
    }
}

// ════════════════════════════════════════════════════════
// 🎵 MINI RADIO PLAYER — popup
// Radio lives in background.js; popup just controls it.
// Player stays active when popup closes or options open.
// ════════════════════════════════════════════════════════
let _miniRadioInitialized = false;
async function initMiniRadio() {
    try {
        const r = await chrome.storage.local.get(['radio_enabled']);
        if (!r.radio_enabled) return;

        const bar    = document.getElementById('mini-radio-bar');
        const nameEl = document.getElementById('mini-radio-name');
        const volEl  = document.getElementById('mini-radio-vol');
        const btn    = document.getElementById('mini-radio-btn');
        if (!bar) return;

        // Get current state from background
        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state) {
            bar.style.display = 'flex';
            if (nameEl && state.stationName) nameEl.textContent = state.stationName;
            if (volEl)  volEl.value = state.volume ?? 70;
            setMiniRadioBtn(btn, state.isPlaying);
        }

        // Attach interactive handlers only once
        if (_miniRadioInitialized) return;
        _miniRadioInitialized = true;

        // Play/Pause
        btn?.addEventListener('click', async () => {
            const st = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
            if (st?.isPlaying) {
                await chrome.runtime.sendMessage({ action: 'radio_pause' });
                setMiniRadioBtn(btn, false);
            } else {
                const r2 = await chrome.storage.local.get(['radio_station','radio_station_name']);
                if (r2.radio_station) {
                    await chrome.runtime.sendMessage({ action: 'radio_play', station: r2.radio_station, stationName: r2.radio_station_name });
                    setMiniRadioBtn(btn, true);
                    if (nameEl && r2.radio_station_name) nameEl.textContent = r2.radio_station_name;
                }
            }
        });

        // Volume
        volEl?.addEventListener('input', () => {
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: parseInt(volEl.value) });
        });

        // Listen for state broadcasts
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.action === 'radio_state') {
                setMiniRadioBtn(btn, msg.state?.isPlaying);
                if (nameEl && msg.state?.stationName) nameEl.textContent = msg.state.stationName;
            }
        });
    } catch(e) { console.warn('Mini radio init:', e); }
}

function setMiniRadioBtn(btn, isPlaying) {
    if (!btn) return;
    btn.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Пауза' : 'Играть';
}

document.addEventListener('DOMContentLoaded', () => initMiniRadio());
