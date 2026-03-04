const PARSE_STRING_REGEXP = /([^\s"']+|"([^"]*)"|'([^']*)')/g;
const PARSE_STRING_QUOTES = /"(.*)"/;

const decoder = new TextDecoder('windows-1251');
// Таймаут запроса: 15с — 4PDA иногда отвечает медленно.
// 5000ms давало ложный N/A при временной нагрузке на сервер.
export const FETCH_TIMEOUT = 15000;

export function parse_response(str) {
    if (!str) return null;
    
    const matches = str.match(PARSE_STRING_REGEXP);
    if (!matches) {
        console.warn('parse_response: no matches found for string:', str);
        return null;
    }
    
    return matches.map(p => {
        let pq = p.match(PARSE_STRING_QUOTES);
        if (pq) return decode_special_chars(pq[1]);
        return parseInt(p, 10);
    });
}

/**
 * @param {string} string 
 * @returns {string} 
 */
function decode_special_chars(string) {
    return string.replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(x?)([0-9A-Fa-f]+);/g, function(match, isHex, num) {
            return String.fromCodePoint(
                parseInt(num, isHex ? 16 : 10)
            );
        });
}

export async function fetch4(url) {
    return fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'text/plain; charset=windows-1251',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
        .then(async response => {
            if (response.ok) {
                return response.arrayBuffer()
                    .then(buffer => decoder.decode(buffer));
            } else {
                throw `Bad request: ${response.status} ${response.statusText}; ${url}`;
            }
        })
}


const pad = (num, size = 2) => String(num).padStart(size, '0');
export function getLogDatetime() {
    // YYYY-MM-DDTHH:mm:ss.sssZ
    let date = new Date();
    return (
        pad(date.getHours()) + ':' +
        pad(date.getMinutes()) + ':' +
        pad(date.getSeconds()) + ',' +
        pad(date.getMilliseconds(), 3)
    );
}