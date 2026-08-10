// Music source detection + query normalization helpers.
//
// Lavalink resolves URLs directly (auto-detecting the platform), and treats
// anything else as a search on the configured search platform (e.g. ytmsearch).
// These helpers identify which platform a query/URL belongs to so the bot can
// label playback, normalize bare URLs, and forward Lavalink search prefixes.

// Order matters: check the most specific host first (music.youtube.com is also
// matched by the generic youtube.com rule below it).
const SOURCE_PATTERNS = [
    { name: 'YouTube Music', pattern: /music\.youtube\.com/i },
    { name: 'YouTube', pattern: /(?:youtube\.com|youtu\.be)/i },
    { name: 'Spotify', pattern: /open\.spotify\.com/i },
    { name: 'SoundCloud', pattern: /soundcloud\.com/i },
    { name: 'Deezer', pattern: /deezer\.com/i },
    { name: 'Apple Music', pattern: /music\.apple\.com/i },
    { name: 'Bandcamp', pattern: /bandcamp\.com/i },
    { name: 'Twitch', pattern: /twitch\.tv/i },
    { name: 'Vimeo', pattern: /vimeo\.com/i },
];

// Lavalink v4 track.info.sourceName -> friendly label.
const SOURCE_NAME_LABELS = {
    youtube: 'YouTube',
    ytmsearch: 'YouTube Music',
    spotify: 'Spotify',
    soundcloud: 'SoundCloud',
    deezer: 'Deezer',
    applemusic: 'Apple Music',
    bandcamp: 'Bandcamp',
    twitch: 'Twitch',
    vimeo: 'Vimeo',
    http: 'Direct URL',
    local: 'Local',
};

// Bare URLs (no scheme) for known streaming hosts. Lavalink only treats a query
// as a URL when it starts with a scheme, so these get `https://` prepended.
const STREAMING_HOST_START =
    /^(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com|deezer\.com|music\.apple\.com|bandcamp\.com|twitch\.tv|vimeo\.com)(?:\/|$)/i;

// Lavalink search prefixes the bot understands, both as a /play `source` option
// and typed directly into the query (e.g. `ytsearch:never gonna give you up`).
export const SEARCH_SOURCE_CHOICES = [
    { name: 'YouTube', value: 'ytsearch' },
    { name: 'YouTube Music', value: 'ytmsearch' },
    { name: 'Spotify', value: 'spsearch' },
    { name: 'SoundCloud', value: 'scsearch' },
    { name: 'Deezer', value: 'dzsearch' },
];

const SEARCH_PREFIX_PATTERN =
    /^(ytsearch|ytmsearch|spsearch|scsearch|dzsearch|amsearch|ymsearch|jiosaavnsearch|audiostacksearch):\s*(.*)$/i;

export function getSourceName(value) {
    if (typeof value !== 'string' || !value) {
        return null;
    }
    for (const { name, pattern } of SOURCE_PATTERNS) {
        if (pattern.test(value)) {
            return name;
        }
    }
    return null;
}

export function getTrackSourceName(track) {
    const raw = track?.info?.sourceName;
    if (raw) {
        const label = SOURCE_NAME_LABELS[String(raw).toLowerCase()];
        if (label) {
            return label;
        }
    }
    return getSourceName(track?.info?.uri);
}

export function isYouTubeUrl(value) {
    const source = getSourceName(value);
    return source === 'YouTube' || source === 'YouTube Music';
}

export function isYouTubePlaylistUrl(value) {
    return (
        typeof value === 'string'
        && /(?:youtube\.com|youtu\.be)[^ ]*(?:\/playlist\?|\?.*[?&]list=)/i.test(value)
    );
}

// Prepends a scheme to bare streaming URLs so Lavalink loads them as URLs
// instead of treating them as search text. Explicit web URLs and other
// schemes (e.g. spotify:track:...) are passed through untouched.
export function normalizeQueryUrl(query) {
    if (typeof query !== 'string' || !query.trim()) {
        return query;
    }
    const trimmed = query.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return trimmed;
    }
    if (!/\s/.test(trimmed) && STREAMING_HOST_START.test(trimmed)) {
        return `https://${trimmed}`;
    }
    return trimmed;
}

// Splits a leading Lavalink search prefix out of a query (if present) so Riffy
// does not double-prefix it with the default search platform.
export function parseSearchPrefix(query) {
    if (typeof query !== 'string') {
        return { source: null, query };
    }
    const match = SEARCH_PREFIX_PATTERN.exec(query.trim());
    if (match) {
        return { source: match[1].toLowerCase(), query: match[2] };
    }
    return { source: null, query };
}
