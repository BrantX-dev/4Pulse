// page_watcher.js — Content Script
// Отслеживает открытие страниц тем 4pda и мгновенно уведомляет background
// об изменении счётчика непрочитанных.

(function () {
    'use strict';

    // Извлекаем ID темы из URL
    function getTopicId() {
        const match = location.search.match(/[?&]showtopic=(\d+)/);
        return match ? match[1] : null;
    }

    // Проверяем, является ли текущая страница последней страницей темы
    // (пользователь дочитал до конца → тема считается прочитанной)
    function isLastPage() {
        const current = document.querySelector('span.pagecurrent-wa');
        const next = current && current.nextElementSibling;
        // Если нет пагинации вообще или нет следующей страницы — это конец
        if (!document.querySelector('.pagination, .paged')) return true;
        if (current && !next) return true;
        return false;
    }

    // Сообщаем в background, что тема была открыта/прочитана
    function notifyTopicOpened(topicId, isRead) {
        try {
            chrome.runtime.sendMessage({
                action: 'page_topic_opened',
                topic_id: topicId,
                is_read: isRead
            }).catch(() => {
                // Background может быть временно недоступен
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // Основная функция — вызывается при загрузке страницы
    function checkPage() {
        const topicId = getTopicId();
        if (!topicId) return;

        const read = isLastPage();
notifyTopicOpened(topicId, read);
    }

    // Запускаем при загрузке DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkPage);
    } else {
        checkPage();
    }

})();
