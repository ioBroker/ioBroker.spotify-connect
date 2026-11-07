type Name = { en: string; de: string; ru: string };

export interface StateDef {
    name: Name;
    type: ioBroker.CommonType;
    role: string;
    read?: boolean;
    write?: boolean;
    unit?: string;
    states?: Record<string, string>;
    min?: number;
    max?: number;
    def?: ioBroker.StateValue;
}

export const CHANNELS: Record<string, Name> = {
    player: { en: 'Now playing', de: 'Aktuelle Wiedergabe', ru: 'Сейчас играет' },
    control: { en: 'Control', de: 'Steuerung', ru: 'Управление' },
    stream: { en: 'Audio stream', de: 'Audio-Stream', ru: 'Аудиопоток' },
};

const STATUS = { idle: 'idle', playing: 'playing', paused: 'paused', buffering: 'buffering' };
const REPEAT = { off: 'off', context: 'context', track: 'track' };

export const STATES: Record<string, StateDef> = {
    'info.loggedIn': { name: { en: 'Spotify account connected', de: 'Spotify-Konto verbunden', ru: 'Аккаунт Spotify подключён' }, type: 'boolean', role: 'indicator', def: false },
    'info.active': { name: { en: 'Active Spotify Connect device', de: 'Aktives Spotify-Connect-Gerät', ru: 'Активное устройство Spotify Connect' }, type: 'boolean', role: 'indicator', def: false },
    'info.soloistVersion': { name: { en: 'Spotify Soloist version', de: 'Version von Spotify Soloist', ru: 'Версия Spotify Soloist' }, type: 'string', role: 'text', def: '' },
    'info.buildDate': { name: { en: 'Soloist build date', de: 'Build-Datum von Soloist', ru: 'Дата сборки Soloist' }, type: 'string', role: 'text', def: '' },
    'info.expiresInDays': { name: { en: 'Days until the Soloist build expires', de: 'Tage bis zum Ablauf des Soloist-Builds', ru: 'Дней до истечения сборки Soloist' }, type: 'number', role: 'value', unit: 'd', def: 0 },
    'info.lastUpdateCheck': { name: { en: 'Last update check', de: 'Letzte Update-Prüfung', ru: 'Последняя проверка обновлений' }, type: 'number', role: 'date', def: 0 },
    'info.updateError': { name: { en: 'Last update error', de: 'Letzter Update-Fehler', ru: 'Последняя ошибка обновления' }, type: 'string', role: 'text', def: '' },

    'player.status': { name: { en: 'Playback status', de: 'Wiedergabestatus', ru: 'Статус воспроизведения' }, type: 'string', role: 'media.state', def: 'idle', states: STATUS },
    'player.title': { name: { en: 'Title', de: 'Titel', ru: 'Название' }, type: 'string', role: 'media.title', def: '' },
    'player.artist': { name: { en: 'Artist', de: 'Interpret', ru: 'Исполнитель' }, type: 'string', role: 'media.artist', def: '' },
    'player.album': { name: { en: 'Album', de: 'Album', ru: 'Альбом' }, type: 'string', role: 'media.album', def: '' },
    'player.cover': { name: { en: 'Cover', de: 'Cover', ru: 'Обложка' }, type: 'string', role: 'media.cover', def: '' },
    'player.uri': { name: { en: 'Spotify URI', de: 'Spotify-URI', ru: 'Spotify URI' }, type: 'string', role: 'text', def: '' },
    'player.context': { name: { en: 'Playing from (playlist, album)', de: 'Gespielt aus (Playlist, Album)', ru: 'Источник (плейлист, альбом)' }, type: 'string', role: 'text', def: '' },
    'player.duration': { name: { en: 'Duration', de: 'Dauer', ru: 'Длительность' }, type: 'number', role: 'media.duration', unit: 's', def: 0 },
    'player.elapsed': { name: { en: 'Position', de: 'Position', ru: 'Позиция' }, type: 'number', role: 'media.elapsed', unit: 's', def: 0 },
    'player.shuffle': { name: { en: 'Shuffle', de: 'Zufallswiedergabe', ru: 'Перемешивание' }, type: 'boolean', role: 'media.mode.shuffle', def: false },
    'player.repeat': { name: { en: 'Repeat', de: 'Wiederholen', ru: 'Повтор' }, type: 'string', role: 'media.mode.repeat', def: 'off', states: REPEAT },

    'control.play': { name: { en: 'Play / resume', de: 'Abspielen / fortsetzen', ru: 'Воспроизвести / продолжить' }, type: 'boolean', role: 'button.play', read: false, write: true },
    'control.pause': { name: { en: 'Pause', de: 'Pause', ru: 'Пауза' }, type: 'boolean', role: 'button.pause', read: false, write: true },
    'control.next': { name: { en: 'Next track', de: 'Nächster Titel', ru: 'Следующий трек' }, type: 'boolean', role: 'button.next', read: false, write: true },
    'control.previous': { name: { en: 'Previous track', de: 'Vorheriger Titel', ru: 'Предыдущий трек' }, type: 'boolean', role: 'button.prev', read: false, write: true },
    'control.activate': { name: { en: 'Make this the active Spotify device', de: 'Zum aktiven Spotify-Gerät machen', ru: 'Сделать активным устройством Spotify' }, type: 'boolean', role: 'button', read: false, write: true },
    'control.volume': { name: { en: 'Volume', de: 'Lautstärke', ru: 'Громкость' }, type: 'number', role: 'level.volume', write: true, min: 0, max: 100, unit: '%', def: 0 },
    'control.seek': { name: { en: 'Seek to position', de: 'Zu Position springen', ru: 'Перейти к позиции' }, type: 'number', role: 'media.seek', write: true, unit: 's', def: 0 },
    'control.shuffle': { name: { en: 'Shuffle', de: 'Zufallswiedergabe', ru: 'Перемешивание' }, type: 'boolean', role: 'media.mode.shuffle', write: true, def: false },
    'control.repeat': { name: { en: 'Repeat (off, context, track)', de: 'Wiederholen (off, context, track)', ru: 'Повтор (off, context, track)' }, type: 'string', role: 'media.mode.repeat', write: true, def: 'off', states: REPEAT },
    // role "text", not "media.url": this state must not show up as a target player
    'control.playUri': { name: { en: 'Play Spotify URI (track, album, playlist)', de: 'Spotify-URI abspielen (Titel, Album, Playlist)', ru: 'Воспроизвести Spotify URI (трек, альбом, плейлист)' }, type: 'string', role: 'text', write: true, def: '' },

    'stream.url': { name: { en: 'Stream URL', de: 'Stream-URL', ru: 'URL потока' }, type: 'string', role: 'url', def: '' },
    'stream.clients': { name: { en: 'Connected players', de: 'Verbundene Player', ru: 'Подключённые плееры' }, type: 'number', role: 'value', def: 0 },
};
