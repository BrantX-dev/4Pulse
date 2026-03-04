// background.js - Chrome Extension MV3 Service Worker
import {CS, SETTINGS} from './js/cs.js';
import {open_url} from './js/browser.js';
import {getLogDatetime} from "./js/utils.js";

// 🛡️ Global error handlers
self.addEventListener('unhandledrejection', (event) => {
    console.error('🚨 Unhandled promise rejection:', {
        reason: event.reason,
        promise: event.promise
    });
    event.preventDefault(); // Prevent extension crash
});

self.addEventListener('error', (event) => {
    console.error('🚨 Global error:', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });
});

const ALARM_NAME = 'periodicUpdate';
const bg = new CS();

// 🔊 Audio cache for better performance
const audioCache = {};

// ════════════════════════════════════════════════════════
// 🎵 RADIO — persistent audio player in background
// ════════════════════════════════════════════════════════
let radioAudio = null;
let radioState = {
    enabled:  false,
    isPlaying: false,
    station:  '',
    stationName: '',
    volume:   0.7,
};

async function loadRadioState() {
    try {
        const s = await chrome.storage.local.get([
            'radio_enabled','radio_playing','radio_station','radio_station_name','radio_volume'
        ]);
        radioState.enabled      = s.radio_enabled     ?? false;
        radioState.isPlaying    = s.radio_playing      ?? false;
        radioState.station      = s.radio_station      ?? '';
        radioState.stationName  = s.radio_station_name ?? '';
        radioState.volume       = s.radio_volume       !== undefined ? s.radio_volume / 100 : 0.7;
    } catch(e) { console.error('Radio loadState:', e); }
}

async function saveRadioState() {
    try {
        await chrome.storage.local.set({
            radio_enabled:       radioState.enabled,
            radio_playing:       radioState.isPlaying,
            radio_station:       radioState.station,
            radio_station_name:  radioState.stationName,
            radio_volume:        Math.round(radioState.volume * 100),
        });
    } catch(e) {}
}

function getOrCreateRadioAudio() {
    if (!radioAudio) {
        radioAudio = new Audio();
        radioAudio.volume = radioState.volume;
        radioAudio.onerror = () => {
            console.warn('🎵 Radio stream error');
            radioState.isPlaying = false;
            saveRadioState();
            broadcastRadioState();
        };
    }
    return radioAudio;
}

function broadcastRadioState() {
    chrome.runtime.sendMessage({ action: 'radio_state', state: getRadioPublicState() }).catch(()=>{});
}

function getRadioPublicState() {
    return {
        enabled:     radioState.enabled,
        isPlaying:   radioState.isPlaying,
        station:     radioState.station,
        stationName: radioState.stationName,
        volume:      Math.round(radioState.volume * 100),
    };
}

async function radioPlay(stationUrl, stationName) {
    if (stationUrl) {
        radioState.station     = stationUrl;
        radioState.stationName = stationName || '';
    }
    if (!radioState.station) return;
    const audio = getOrCreateRadioAudio();
    if (audio.src !== radioState.station) {
        audio.src = radioState.station;
    }
    audio.volume = radioState.volume;
    try {
        await audio.play();
        radioState.isPlaying = true;
    } catch(e) {
        console.error('🎵 Radio play error:', e);
        radioState.isPlaying = false;
    }
    await saveRadioState();
    broadcastRadioState();
}

async function radioPause() {
    if (radioAudio) radioAudio.pause();
    radioState.isPlaying = false;
    await saveRadioState();
    broadcastRadioState();
}

async function radioSetVolume(pct) {
    radioState.volume = Math.max(0, Math.min(1, pct / 100));
    if (radioAudio) radioAudio.volume = radioState.volume;
    await saveRadioState();
}

// ════════════════════════════════════════════════════════
// 🔧 FIX: Load SETTINGS from storage on startup
// Without this, after restart SETTINGS keeps defaults and
// notifications fire even when the user disabled them!
// ════════════════════════════════════════════════════════
async function syncSettingsFromStorage() {
    try {
        const stored = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(stored)) {
            if (k in SETTINGS) SETTINGS[k] = v;
        }
    } catch(e) { console.error('syncSettings:', e); }
}

// 🌙 DND — проверяет, активен ли режим «Не беспокоить» прямо сейчас
async function isDndActive(type) {
    try {
        const s = await chrome.storage.local.get([
            'dnd_enabled', 'dnd_from', 'dnd_to', 'dnd_days', 'dnd_allow_mentions'
        ]);
        if (!s.dnd_enabled) return false;

        // Упоминания пробиваются сквозь DND если включена опция
        if (type === 'mentions' && s.dnd_allow_mentions) return false;

        const now = new Date();
        const day = now.getDay(); // 0=Вс … 6=Сб

        const days = Array.isArray(s.dnd_days) ? s.dnd_days : [0,1,2,3,4,5,6];
        if (!days.includes(day)) return false;

        // Парсим HH:MM
        const parseTime = (str) => {
            const [h, m] = (str || '23:00').split(':').map(Number);
            return h * 60 + m;
        };
        const fromMin = parseTime(s.dnd_from || '23:00');
        const toMin   = parseTime(s.dnd_to   || '08:00');
        const nowMin  = now.getHours() * 60 + now.getMinutes();

        // Диапазон может переходить через полночь (23:00 → 08:00)
        if (fromMin <= toMin) {
            return nowMin >= fromMin && nowMin < toMin;
        } else {
            return nowMin >= fromMin || nowMin < toMin;
        }
    } catch {
        return false;
    }
}

// 🔊 Play notification sound - Firefox compatible version
async function playNotificationSound(type) {
    try {
        // 🌙 Не играть звук в режиме DND
        if (await isDndActive(type)) return;

        // Check if sound is enabled for this type
        const settings = await chrome.storage.local.get([
            'sound_qms', 'sound_themes', 'sound_themes_all_comments', 'sound_mentions',
            'sound_file_qms', 'sound_file_themes', 'sound_file_mentions',
            'sound_volume'
        ]);
        
        // Check if this type of sound is enabled
        const soundEnabled = {
            'qms': settings.sound_qms,
            'themes': settings.sound_themes,
            'themes_comment': settings.sound_themes || settings.sound_themes_all_comments,
            'mentions': settings.sound_mentions
        };
        
        if (!soundEnabled[type]) {
            return;
        }
        
        // 🆕 Per-type sound file selection
        const soundFileMap = {
            'qms':           settings.sound_file_qms     || 'notify',
            'themes':        settings.sound_file_themes   || 'notify',
            'themes_comment':settings.sound_file_themes   || 'notify',
            'mentions':      settings.sound_file_mentions || 'notify',
        };
        const soundFile = soundFileMap[type] || 'notify';
        const volume = (settings.sound_volume !== undefined ? settings.sound_volume : 50) / 100;
        
        
        // Firefox: Use Audio API directly (works in background pages)
        const soundUrl = chrome.runtime.getURL(`sounds/${soundFile}.ogg`);
        
        // Create or reuse audio element
        if (!audioCache[soundFile]) {
            audioCache[soundFile] = new Audio(soundUrl);
        }
        
        const audio = audioCache[soundFile];
        audio.volume = Math.max(0, Math.min(1, volume)); // Clamp to 0-1
        
        // Reset to start if already playing
        audio.currentTime = 0;
        
        // Play sound
        await audio.play();
        
        
    } catch (error) {
        console.error('🔊 Failed to play notification sound:', error);
    }
}

// 🔊 Export for use in other modules
globalThis.playNotificationSound = playNotificationSound;
globalThis.isDndActive = isDndActive;

// ════════════════════════════════════════════════════════
// 🎯 PRIORITY BLINK — иконка мигает когда есть обновление
//    в "приоритетной" теме (режим концентрации)
// ════════════════════════════════════════════════════════
let _priorityBlinkInterval = null;
let _priorityBlinkPhase    = false;

function startPriorityBlink() {
    if (_priorityBlinkInterval) return; // already blinking
    _priorityBlinkPhase = false;
    _priorityBlinkInterval = setInterval(() => {
        _priorityBlinkPhase = !_priorityBlinkPhase;
        if (_priorityBlinkPhase) {
            // Orange phase — high priority color
            chrome.action.setBadgeBackgroundColor({ color: '#f97316' }).catch(()=>{});
            chrome.action.setBadgeText({ text: '🎯' }).catch(()=>{});
        } else {
            // Normal phase — restore via update_action
            bg.update_action();
        }
    }, 700);
}

function stopPriorityBlink() {
    if (_priorityBlinkInterval) {
        clearInterval(_priorityBlinkInterval);
        _priorityBlinkInterval = null;
    }
    // Restore normal icon/badge
    bg.update_action();
}

globalThis.startPriorityBlink = startPriorityBlink;
globalThis.stopPriorityBlink  = stopPriorityBlink;

// Initialize alarm on install
chrome.runtime.onInstalled.addListener(reason => {
    loadRadioState();
    
    // Сразу ставим серую иконку до первого входа
    chrome.action.setIcon({ path: {
        16: 'img/icons/icon_19_out.png',
        19: 'img/icons/icon_19_out.png',
        32: 'img/icons/icon_19_out.png',
        48: 'img/icons/icon_19_out.png'
    }});
    
    // Create context menu
    chrome.contextMenus.create({
        title: '4Pulse: Принудительное обновление',
        id: 'update.all',
        contexts: ["action"],
        icons: { '16': 'img/icons/icon_48.png', '32': 'img/icons/icon_48.png' },
    });
    
    // Initialize alarm immediately
    initializeAlarm();
});

// Reinitialize alarm on browser startup
chrome.runtime.onStartup.addListener(async () => {
    // 🔧 FIX: Load SETTINGS from storage BEFORE first alarm fires
    // CS#init also loads settings but takes a few seconds; this ensures
    // notification level is correct immediately (fixes phantom notifications)
    syncSettingsFromStorage().catch(()=>{});
    await loadRadioState();
    // Auto-restore radio if it was playing before browser restart
    if (radioState.enabled && radioState.isPlaying && radioState.station) {
        radioPlay();
    }
    
    // Ставим серую иконку сразу при старте браузера, до первого запроса
    chrome.action.setIcon({ path: {
        16: 'img/icons/icon_19_out.png',
        19: 'img/icons/icon_19_out.png',
        32: 'img/icons/icon_19_out.png',
        48: 'img/icons/icon_19_out.png'
    }});
    
    // Восстанавливаем авторежим: alarm создаётся всегда — он управляет фоновым обновлением
    // auto_mode_active в storage используется только для popup-polling
    const stored = await chrome.storage.local.get(['auto_mode_active']);
    initializeAlarm();
});

// Function to create/update the alarm with current backoff multiplier
async function initializeAlarm() {
    // Clear existing alarm first
    chrome.alarms.clear(ALARM_NAME, async (wasCleared) => {
        
        const stored = await chrome.storage.local.get([
            'backoff_multiplier',
            'backoff_until',
            'is_429_active',
            'last_429_time'
        ]);

        const now = Date.now();
        let multiplier = stored.backoff_multiplier || 1.0;

        // Если был недавний бан (менее 15 мин назад) — принудительно замедляемся
        if (stored.is_429_active || (stored.last_429_time && (now - stored.last_429_time < 900000))) {
            multiplier = Math.max(multiplier, 5.0);
            console.warn(`🛡️ Защитный режим: множитель увеличен до ${multiplier}x из-за недавних лимитов`);
        }

        // Chrome MV3 минимум — 1 минута
        const baseInterval = Math.max(SETTINGS.interval / 60, 1.0);
        const backoffInterval = baseInterval * multiplier;

        // Jitter ±20% для рандомизации паттерна запросов
        const jitter = backoffInterval * 0.2 * (Math.random() * 2 - 1);
        const finalInterval = Math.max(backoffInterval + jitter, 1.0);

        // Запуск через 30 сек после старта (или позже, если ещё в backoff)
        let delayMinutes = 0.5;
        if (stored.backoff_until > now) {
            delayMinutes = Math.max((stored.backoff_until - now) / 60000, 1.0);
        }
        
        // Create new alarm
        chrome.alarms.create(ALARM_NAME, {
            delayInMinutes: delayMinutes,
            periodInMinutes: finalInterval
        });
        
    });
}

// Listen to alarm events
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        // Не обновляем если экран заблокирован; если idle — пропускаем 2/3 срабатываний
        chrome.idle.queryState(300, (state) => {
            if (state === 'locked') {
                return;
            }
            if (state === 'idle' && Math.random() > 0.33) {
                return;
            }
            bg.update();
        });
    }
});

// Listen for backoff state changes - merged below with main storage listener

chrome.idle.onStateChanged.addListener(newState => {
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    switch (info.menuItemId) {
        case 'update.all':
            bg.update(true); // Force refresh with full HTML fetch
            break;
    }
});

// Listen for messages from popup or other extension parts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'radio_get_state':
            sendResponse(getRadioPublicState());
            break;

        case 'radio_play':
            radioPlay(message.station, message.stationName).then(() => sendResponse(getRadioPublicState()));
            return true;

        case 'radio_pause':
            radioPause().then(() => sendResponse(getRadioPublicState()));
            return true;

        case 'radio_set_volume':
            radioSetVolume(message.volume).then(() => sendResponse({ ok: true }));
            return true;

        case 'radio_set_enabled':
            radioState.enabled = !!message.enabled;
            if (!radioState.enabled) radioPause();
            else saveRadioState();
            sendResponse({ ok: true });
            break;

        case 'popup_loaded':
            // Stop blink when user opens popup
            stopPriorityBlink();
            if (bg.user_id) {
                sendResponse(bg.popup_data);
            } else {
                // 🔧 FIX: Service worker may still be initializing (MV3 restarts).
                // Wait up to 4s for user_id to appear before giving up and redirecting to auth.
                (async () => {
                    let waited = 0;
                    while (!bg.user_id && waited < 4000) {
                        await new Promise(r => setTimeout(r, 250));
                        waited += 250;
                    }
                    if (bg.user_id) {
                        sendResponse(bg.popup_data);
                    } else {
                        open_url('https://4pda.to/forum/index.php?act=auth');
                        sendResponse(null);
                    }
                })();
            }
            return true;
            
        case 'force_update':
            // 🆕 NEW: Force immediate update with full HTML page fetch (forceRefresh = true)
            bg.update(true).then(() => {
                sendResponse({ success: true });
            }).catch(error => {
                console.error('❌ Force update failed:', error);
                sendResponse({ success: false });
            });
            return true; // Keep channel open for async response

        case 'stop_priority_blink':
            stopPriorityBlink();
            sendResponse({ ok: true });
            break;
        case 'mark_as_read':
            bg.favorites.do_read(message.id)
                .then(result => {
                    // If there are no more unread focused topics, stop blinking
                    chrome.storage.local.get(['focused_topics']).then(stored => {
                        const ft = (stored.focused_topics || []).map(String);
                        const anyFocusedUnread = bg.favorites.list.some(
                            t => !t.viewed && ft.includes(String(t.id))
                        );
                        if (!anyFocusedUnread) stopPriorityBlink();
                    });
                    sendResponse(result);
                })
                .catch((error) => {
                    console.error('Error marking theme as read:', error);
                    sendResponse(false);
                });
            return true; // Keep channel open for async response
        case 'open_url': {
            // Из сайдбара (message.sidebar===true) всегда открываем вкладку активной,
            // т.к. сайдбар не закрывается сам в отличие от попапа.
            const setActive = message.sidebar === true ? true : SETTINGS.toolbar_open_theme_hide;

            switch (message.what) {
                case 'user':
                    return open_url(`https://4pda.to/forum/index.php?showuser=${bg.user_id}`, true, true);
                case 'options':
                    return open_url(chrome.runtime.getURL('/html/options.html'), true, true);
                case 'qms':
                    if (message.dialog_id) {
                        const dialogId = message.dialog_id;
                        const marked = bg.qms.markAsViewed(dialogId);
                        if (marked) bg.update_action();
                    }
                    if (message.opponent_id && message.dialog_id && message.dialog_id !== message.opponent_id) {
                        return open_url(
                            `https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}&t=${message.dialog_id}`,
                            setActive, false
                        );
                    }
                    if (message.opponent_id) {
                        return open_url(
                            `https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}`,
                            setActive, false
                        );
                    }
                    return bg.qms.open();

                case 'favorites':
                    bg.favorites.open(message['id'], message['view'], setActive)
                        .then(async ([tab, theme]) => {
                            if (theme && theme.viewed) {
                                await bg.mentions.markTopicMentionsAsViewed(theme.id);
                                bg.update_action();
                            }
                        }).catch(err => { console.warn('Error opening favorite:', err); });
                    break;

                case 'mentions':
                    if (message.topic_id && message.post_id) {
                        const mentionId = `${message.topic_id}_${message.post_id}`;
                        bg.mentions.markAsViewed(mentionId)
                            .then(() => bg.update_action())
                            .catch(err => { console.error('Failed to save mention viewed state:', err); });
                        bg.update_action();
                        return open_url(
                            `https://4pda.to/forum/index.php?showtopic=${message.topic_id}&view=findpost&p=${message.post_id}`,
                            setActive, false
                        );
                    }
                    return bg.mentions.open();
            }
            break;
        }
        case 'get_counts':
            // Return current counts for popup polling
            sendResponse({
                favorites: bg.favorites.count,
                qms: bg.qms.count,
                mentions: bg.mentions.count
            });
            break;
        
        case 'page_topic_opened':
            // 🆕 NEW: Content script сообщает, что пользователь открыл тему напрямую в браузере
            // Мгновенно помечаем тему как прочитанную и обновляем бейдж
            if (message.topic_id && message.is_read) {
                const topicId = String(message.topic_id);
                const theme = bg.favorites._list[topicId];
                if (theme && !theme.viewed) {
                    theme.viewed = true;
                    bg.update_action();
                }
            }
            break;
        case 'request':
            switch (message.what) {
                case 'favorites.count':
                    sendResponse(bg.favorites.count);
                    break;
                case 'qms.count':
                    sendResponse(bg.qms.count);
                    break;
                case 'mentions.count':
                    sendResponse(bg.mentions.count);
                    break;
            }
            break;
        case 'fetch_qms_subject':
            // 🆕 NEW: Fetch dialog subject for a specific QMS user
            if (message.opponent_id) {
                bg.qms.fetchDialogSubject(message.opponent_id)
                    .then(result => {
                        sendResponse(result);
                    })
                    .catch(error => {
                        console.error('Error fetching QMS subject:', error);
                        sendResponse(null);
                    });
                return true; // Keep channel open for async response
            }
            break;
    }
    // 🔧 FIX: Don't return true by default!
    // Only cases that call sendResponse() asynchronously should return true.
    // Returning true here would cause "message channel closed" errors for cases
    // that handle responses synchronously or don't send responses at all.
});

chrome.runtime.onConnect.addListener(async (port) => {
    
    const isPortConnected = () => {
        try {
            return port.name !== undefined;
        } catch (e) {
            return false;
        }
    };

    const safePostMessage = (msg) => {
        try {
            if (isPortConnected()) {
                port.postMessage(msg);
                return true;
            }
        } catch (e) {
            console.warn('Port disconnected, cannot send message:', e);
        }
        return false;
    };

    switch (port.name) {
        case 'themes-read-all':
            for (let theme of bg.favorites.list) {
                if (await theme.read()) {
                    safePostMessage({
                        id: theme.id,
                        count: bg.favorites.count,
                    });
                }
            }
            break;
        case 'themes-open-all':
            let count_TPA = 0;
            for (let theme of bg.favorites.list) {
                theme.open(false, false)
                    .then(([tab, theme]) => {
                        if (theme.viewed) {
                            safePostMessage({
                                id: theme.id,
                                count: bg.favorites.count,
                            });
                        }
                    })
                    .catch(err => console.warn('Error opening theme:', err));
                if (++count_TPA >= SETTINGS.open_themes_limit) break;
            }
            break;
        case 'themes-open-all-pin':
            let count_TPAP = 0;
            for (let theme of bg.favorites.list_pin) {
                theme.open(false, false)
                    .then(([tab, theme]) => {
                        if (theme.viewed) {
                            safePostMessage({
                                id: theme.id,
                                count: bg.favorites.count,
                            });
                        }
                    })
                    .catch(err => console.warn('Error opening pinned theme:', err));
                if (++count_TPAP >= SETTINGS.open_themes_limit) break;
            }
            break;
    }
    
    port.onDisconnect.addListener(() => {
    });
});

chrome.notifications.onClicked.addListener(notificationId => {
    const n_data = notificationId.split('/'),
        funcs = {
            theme: (id) => bg.favorites.open(id, 'getlastpost'),
            dialog: (id) => bg.qms.open(id),
            mention: (id) => bg.mentions.open(id),
        };

    if (n_data[1] in funcs) {
        funcs[n_data[1]](n_data[2])
            .then(([tab, entity]) => {
                chrome.windows.update(tab.windowId, { focused: true });
            })
            .catch(err => console.error('Error handling notification click:', err));
    }
    chrome.notifications.clear(notificationId);
});

// Единый обработчик изменений storage
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    // Синхронизируем SETTINGS
    for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
        SETTINGS[key] = newValue;
    }

    // Backoff / alarm — пересоздать если нужно
    if (changes.backoff_multiplier) {
        const oldM = changes.backoff_multiplier.oldValue || 1.0;
        const newM = changes.backoff_multiplier.newValue || 1.0;
        if (oldM !== newM) initializeAlarm();
    }
    if (changes.is_429_active || changes.interval) {
        initializeAlarm();
    }

    if (!bg.initialized) return;

    // Реакция на конкретные настройки
    if (changes.toolbar_pin_themes_level) {
        const { oldValue, newValue } = changes.toolbar_pin_themes_level;
        if (oldValue == 20) bg.favorites.filter_pin(false);
        else if (newValue == 20) bg.favorites.filter_pin(true);
    }
    if (changes.interval) {
        initializeAlarm();
    }
});
