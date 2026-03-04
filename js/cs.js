import { parse_response, fetch4, getLogDatetime, FETCH_TIMEOUT } from "./utils.js";
import { Favorites } from "./e/favorites.js";
import { Mentions } from "./e/mentions.js";
import { QMS } from "./e/qms.js";
import { print_count, print_logout, print_unavailable } from "./browser.js";

const PARSE_APPBK_REGEXP = /u\d+:\d+:\d+:(\d+)/;

export let SETTINGS = {
    notification_qms_level: 10,
    notification_themes_level: 10,
    notification_mentions_level: 20,
    toolbar_pin_themes_level: 0,
    toolbar_open_theme_hide: false,  // 🔧 FIXED: Changed from true to false
    toolbar_button_open_all: true,
    toolbar_button_read_all: true,
    toolbar_simple_list: false,
    toolbar_default_view: 'favorites',  // 🔧 FIXED: Changed from 'collapsed' to 'favorites'
    show_all_favorites: false,
    show_all_qms: false,
    show_all_mentions: false,
    open_themes_limit: 5,
    interval: 60,  // 60 секунд — безопасный интервал для избежания 429
    open_in_current_tab: false,  // 🆕 NEW: Open links in current tab instead of new tabs
    bw_icons: false,  // 🆕 NEW: Black & white icons
    accent_color: 'blue',  // 🆕 NEW: Accent color (blue/green)
    compact_mode: false,  // 🆕 NEW: Компактный режим карточек
    // 🔊 Sound settings
    sound_qms: false,
    sound_themes: false,
    sound_themes_all_comments: false,
    sound_mentions: false,
    // 🆕 Отдельная мелодия для каждого типа уведомлений
    sound_file_qms: 'notify',
    sound_file_themes: 'notify',
    sound_file_mentions: 'notify',
    sound_volume: 50,
    // 🌙 DND — Режим «Не беспокоить»
    dnd_enabled: false,
    dnd_from: '23:00',
    dnd_to: '08:00',
    dnd_days: [0, 1, 2, 3, 4, 5, 6],
    dnd_allow_mentions: false,
    // 🎵 Radio
    radio_enabled: false,
    radio_playing: false,
    radio_station: '',
    radio_station_name: '',
    radio_volume: 70,
}

// Helper function to wait/sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class CS {
    #initialized = false;
    #update_in_process = false;
    #cookie_authorized = false;
    #available = true;
    #user_id = 0;
    #user_name = '';
    #user_avatar = ''; // URL аватара
    
    // Метод для загрузки аватара пользователя
    async #fetch_user_avatar() {
        if (!this.#user_id) return '';
        
        try {
            const response = await fetch(`https://4pda.to/forum/index.php?showuser=${this.#user_id}`);
            const html = await response.text();
            
            // Ищем URL аватара в HTML
            const avatarMatch = html.match(/<img[^>]+src=["'](https:\/\/4pda\.to\/s\/[^"']+)["'][^>]*alt=["']Аватар/i);
            if (avatarMatch && avatarMatch[1]) {
                this.#user_avatar = avatarMatch[1];
                // 🔧 FIX: Cache avatar too
                chrome.storage.local.set({ cached_user_avatar: this.#user_avatar }).catch(() => {});
                return this.#user_avatar;
            }
        } catch (error) {
            console.error('Failed to fetch avatar:', error);
        }
        
        return '';
    }
    #last_event = 0;
    
    // 🚀 NEW: Exponential backoff state
    #rate_limit_count = 0;
    #backoff_multiplier = 1.0;
    #backoff_until = 0;
    #consecutive_successes = 0;
    // 🛡️ FIX: N/A только после 2+ подряд ошибок сети (одиночный таймаут — не причина)
    #consecutive_errors = 0;
    static #MAX_ERRORS_BEFORE_UNAVAILABLE = 3;

    constructor() {

        this.favorites = new Favorites(this);
        this.qms = new QMS(this);
        this.mentions = new Mentions(this);

        this.#init();
    }

    async #init() {
        try {
            // Load settings
            const items = await chrome.storage.local.get(Object.keys(SETTINGS));
            let to_save = {};
            for (const [key, value] of Object.entries(SETTINGS)) {
                if (key in items) SETTINGS[key] = items[key];
                else to_save[key] = value;
            }
            if (Object.keys(to_save).length) {
                await chrome.storage.local.set(to_save);
            }

            // Load backoff state (survives service worker restarts)
            const backoffState = await chrome.storage.local.get(['backoff_multiplier', 'backoff_until', 'rate_limit_count']);
            if (backoffState.backoff_multiplier) {
                this.#backoff_multiplier = backoffState.backoff_multiplier;
                this.#backoff_until = backoffState.backoff_until || 0;
                this.#rate_limit_count = backoffState.rate_limit_count || 0;
            }

            const start_member_id = await this.#get_cookie_member_id();
            this.#cookie_authorized = start_member_id != null;

            // 🔧 FIX: Restore cached user_id/user_name so popup works immediately
            // on service worker restart (MV3 kills SW after ~5 min idle).
            if (this.#cookie_authorized) {
                const cached = await chrome.storage.local.get(['cached_user_id', 'cached_user_name', 'cached_user_avatar']);
                if (cached.cached_user_id) {
                    this.#user_id     = cached.cached_user_id;
                    this.#user_name   = cached.cached_user_name   || '';
                    this.#user_avatar = cached.cached_user_avatar || '';
                }
            }

            // Heartbeat: check auth state every 5s (no need to poll more often)
            this.heartbeat = setInterval(async () => {
                if (this.#update_in_process) return;
                const member_id = await this.#get_cookie_member_id();
                if (this.#cookie_authorized === (member_id != null)) return;

                if (member_id) {
                    this.#cookie_authorized = true;
                    this.update();
                } else {
                    this.#do_logout();
                    this.#cookie_authorized = false;
                }
            }, 5000);

            if (this.#cookie_authorized) {
                setTimeout(() => this.update(), 2000);
            } else {
                this.#do_logout();
            }
        } catch (error) {
            console.error('❌ CS init failed:', error);
        } finally {
            this.#initialized = true;
        }
    }

    #get_cookie_member_id() {
        return chrome.cookies.get({
            url: 'https://4pda.to',
            name: 'member_id',
        })
            .then(cookie => {
                return cookie ? cookie.value : null;
            });
    }

    #do_logout() {
        this.#user_id = 0;
        this.#user_name = '';
        // 🔧 FIX: Clear cached credentials on logout
        chrome.storage.local.remove(['cached_user_id', 'cached_user_name', 'cached_user_avatar']).catch(() => {});
        print_logout();
    }
    
    // 🚀 NEW: Save backoff state to storage
    async #saveBackoffState(is429 = false) {
        await chrome.storage.local.set({
            backoff_multiplier: this.#backoff_multiplier,
            backoff_until: this.#backoff_until,
            rate_limit_count: this.#rate_limit_count,
            is_429_active: is429,
            last_429_time: is429 ? Date.now() : null
        });
    }
    
    // 🚀 NEW: Trigger rate limit backoff
    async #triggerBackoff() {
        this.#rate_limit_count++;
        
        // Exponential backoff: 2x each time, max 32x (5.3 minutes at 10s interval)
        this.#backoff_multiplier = Math.min(Math.pow(2, this.#rate_limit_count), 32);
        
        // Calculate how long to wait (in milliseconds)
        const baseIntervalMs = SETTINGS.interval * 1000;
        const backoffMs = baseIntervalMs * this.#backoff_multiplier;
        this.#backoff_until = Date.now() + backoffMs;
        
        const backoffMinutes = (backoffMs / 60000).toFixed(1);
        const untilTime = new Date(this.#backoff_until).toLocaleTimeString();
        
        console.warn(`⚠️ Rate limit (429) #${this.#rate_limit_count}!`);
        console.warn(`   Backing off: ${this.#backoff_multiplier.toFixed(1)}x multiplier`);
        console.warn(`   Next attempt: ${backoffMinutes} minutes (${untilTime})`);
        
        // Reset success counter
        this.#consecutive_successes = 0;
        
        // Save state
        await this.#saveBackoffState(true);
    }
    
    // 🚀 NEW: Handle successful request (gradual recovery)
    async #handleSuccess() {
        // 🛡️ FIX: Восстанавливаем статус если были в N/A
        if (!this.#available) {
            this.#available = true;
            this.#consecutive_errors = 0;
            // update_action обновит иконку через print_count после получения данных
        }

        if (this.#backoff_multiplier <= 1.0) {
            // Already at normal speed
            return;
        }
        
        this.#consecutive_successes++;
        
        // After 3 consecutive successes, reduce backoff multiplier by 20%
        if (this.#consecutive_successes >= 3) {
            const oldMultiplier = this.#backoff_multiplier;
            this.#backoff_multiplier = Math.max(this.#backoff_multiplier * 0.5, 1.0);
            
            if (this.#backoff_multiplier === 1.0) {
                this.#rate_limit_count = 0;
                this.#backoff_until = 0;
                await this.#saveBackoffState(false);
            } else {
                await this.#saveBackoffState(true);
            }
            
            this.#consecutive_successes = 0;
        }
    }

    get initialized() { return this.#initialized; }
    get available() { return this.#available; }
    get user_id() { return this.#user_id; }

    get popup_data() {
        return {
            user_id: this.#user_id,
            user_name: this.#user_name,
            user_avatar_url: this.#user_avatar,
            favorites: {
                count: this.favorites.count,
                list: this.favorites.list
            },
            qms: {
                count: this.qms.count,
                list: this.qms.list
            },
            mentions: {
                count: this.mentions.count,
                list: this.mentions.list
            },
            settings: SETTINGS
        };
    }

    update_action() {
        print_count(
            this.qms.count,
            this.favorites.count,
            this.mentions.count
        );
        
        // 🚀 NEW: Broadcast counts to popup in real-time
        this.broadcast_counts();
    }
    
    // 🚀 NEW: Broadcast count updates to all open popups
    broadcast_counts() {
        const counts = {
            favorites: this.favorites.count,
            qms: this.qms.count,
            mentions: this.mentions.count
        };
        
        // Send to popup (if open) - gracefully handle when popup is closed
        try {
            chrome.runtime.sendMessage({
                action: 'counts_updated',
                counts: counts
            }).catch((error) => {
                // Popup might not be open - that's fine, ignore error
                // Common error: "Could not establish connection. Receiving end does not exist."
            });
        } catch (error) {
            // Ignore - popup is probably not open or extension context invalid
        }
    }

    async update(forceRefresh = false) {
        
        if (!this.#cookie_authorized) { return;
        }
        
        if (this.#update_in_process) { return;
        }

        // 🚀 NEW: Check if we're in backoff period (only for automatic updates)
        if (!forceRefresh) {
            const now = Date.now();
            if (now < this.#backoff_until) {
                const waitSeconds = Math.ceil((this.#backoff_until - now) / 1000);
                return;
            }
            
            // 🔧 FIX: If backoff period expired but multiplier still high, reset it
            if (now >= this.#backoff_until && this.#backoff_multiplier > 1.0) {
                this.#backoff_multiplier = 1.0;
                this.#backoff_until = 0;
                this.#rate_limit_count = 0;
                
                try {
                    await this.#saveBackoffState(false);
                } catch (error) {
                    console.error('❌ Failed to save backoff state:', error);
                }
            }
        } else {
        }

        this.#update_in_process = true;

        try {
            const data = await fetch4('https://4pda.to/forum/index.php?act=inspector&CODE=id');
            
            // 🚀 NEW: Success! Handle recovery
            await this.#handleSuccess();
            // 🛡️ FIX: Сбрасываем счётчик ошибок при успешном запросе
            this.#consecutive_errors = 0;

            let user_data = parse_response(data);
            if (user_data && user_data.length == 2) {
                if (user_data[0] == this.#user_id) {
                    this.#user_name = user_data[1];
                } else {
                    this.#user_id = user_data[0];
                    this.#user_name = user_data[1];
                    
                    // 🔧 FIX: Cache user_id/user_name so popup works after SW restart
                    chrome.storage.local.set({
                        cached_user_id:   this.#user_id,
                        cached_user_name: this.#user_name,
                    }).catch(() => {});
                    
                    // Загружаем аватар нового пользователя
                    this.#fetch_user_avatar();

                    this.#last_event = 0;
                    this.favorites.reset();
                    this.qms.reset();
                    this.mentions.reset();
                }   
                await this.#update_all_data(forceRefresh);                 
            } else {
                this.#do_logout();
            }
        } catch (error) {
            const errorStr = String(error);
            console.error('API request failed:', errorStr);
            
            if (errorStr.includes('429')) {
                // 🚀 NEW: Trigger exponential backoff
                await this.#triggerBackoff();
                this.#available = true; // Site is available, just rate limited
                this.#consecutive_errors = 0;
            } else {
                // 🛡️ FIX: Показываем N/A только после нескольких подряд ошибок.
                // Одиночный таймаут или сетевой сбой — ещё не причина ставить N/A.
                this.#consecutive_errors++;
                const errType = errorStr.includes('AbortError') || errorStr.includes('timeout')
                    ? `таймаут (${FETCH_TIMEOUT / 1000}с)`
                    : 'сетевая ошибка';
                console.warn(`⚠️ ${errType} #${this.#consecutive_errors}/${CS.#MAX_ERRORS_BEFORE_UNAVAILABLE}: ${errorStr}`);
                
                if (this.#consecutive_errors >= CS.#MAX_ERRORS_BEFORE_UNAVAILABLE) {
                    console.error(`❌ Сайт недоступен после ${this.#consecutive_errors} ошибок подряд`);
                    this.#available = false;
                    print_unavailable();
                }
                // Иначе — тихо пропускаем, значок не меняем
            }
        } finally {
            this.#update_in_process = false;
        }
    }

    async #update_all_data(forceRefresh = false) {
        try {
            const response = await fetch(
                `https://appbk.4pda.to/er/u${this.#user_id}/s${this.#last_event}`,
                {
                    method: 'GET',
                    signal: AbortSignal.timeout(FETCH_TIMEOUT),
                }
            );
            
            const data = await response.text();
            
            // 🔧 FIX: Check for new events OR force refresh
            let parsed = null;
            if (data) {
                parsed = data.match(PARSE_APPBK_REGEXP);
            }
            
            // Update if: (1) there are new events, OR (2) force refresh requested
            if (parsed || forceRefresh) {
                
                // 🚀 NEW: Stagger requests with 2-second delays
                await this.qms.update(forceRefresh);
                
                await sleep(1500 + Math.random() * 1000);
                await this.favorites.update(forceRefresh);
                
                await sleep(1500 + Math.random() * 1000);
                await this.mentions.update(forceRefresh);
                
                // Update last_event only if there were actual new events
                if (parsed) {
                    this.#last_event = parsed[1];
                }
            }
            
            this.update_action();
            this.#available = true;
            
        } catch (error) {
            console.error('Error in #update_all_data:', error);
            throw error;
        }
    }
}
