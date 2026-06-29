// ====================================================================
//  Yandex Music provider  —  Mineradio (RU adaptation)
//  非官方 Yandex Music 接口，仅用于个人自有账号本地客户端播放。
//  Unofficial Yandex Music API. Personal use with the user's own account.
//
//  设计目标 / Design goals:
//  - 与 QQ / Netease provider 保持同一套「歌曲对象」形状，便于前端复用。
//  - 自包含：自己的 https 请求、OAuth token 存取，不耦合 server.js 内部细节。
//
//  鉴权 / Auth:
//  - 通过 OAuth token（Authorization: OAuth <token>）。
//  - token 来源优先级：环境变量 YANDEX_MUSIC_TOKEN > 本地文件 .ya-token。
//
//  播放链接 / Track URL:
//  - GET /tracks/{id}/download-info  → 选最高码率 mp3 的 downloadInfoUrl
//  - GET {downloadInfoUrl}&format=json → { host, path, ts, s }
//  - sign = md5(SIGN_SALT + path.slice(1) + s)
//  - url  = https://{host}/get-mp3/{sign}/{ts}{path}
// ====================================================================
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://api.music.yandex.net';
// 公认的下载签名盐值（非官方）。Well-known download-info signing salt.
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';
const CLIENT_HEADER = 'YandexMusicAndroid/24023621';
const TOKEN_FILE = process.env.YANDEX_TOKEN_FILE || path.join(__dirname, '.ya-token');

let cachedToken = '';
try {
    if (process.env.YANDEX_MUSIC_TOKEN) cachedToken = String(process.env.YANDEX_MUSIC_TOKEN).trim();
    else if (fs.existsSync(TOKEN_FILE)) cachedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch (e) {
    cachedToken = '';
}

let cachedAccount = null; // { uid, login, displayName, hasPlus }

function getToken() {
    return cachedToken || '';
}

function saveToken(token) {
    cachedToken = String(token || '').trim();
    cachedAccount = null;
    try {
        if (cachedToken) fs.writeFileSync(TOKEN_FILE, cachedToken);
        else if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch (e) { /* 忽略本地写入失败 */
    }
    return cachedToken;
}

function hasToken() {
    return !!getToken();
}

// ---------- 底层请求 ----------
function apiRequest(endpoint, opts) {
    opts = opts || {};
    const token = getToken();
    const url = endpoint.startsWith('http') ? endpoint : API_BASE + endpoint;
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const headers = {
            'User-Agent': 'Yandex-Music-API',
            'X-Yandex-Music-Client': CLIENT_HEADER,
            'Accept-Language': 'ru',
            ...(opts.headers || {}),
        };
        if (token) headers.Authorization = 'OAuth ' + token;
        let body = opts.body || null;
        if (body && typeof body === 'object' && !(body instanceof Buffer)) {
            body = new URLSearchParams(body).toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (body) headers['Content-Length'] = Buffer.byteLength(body);
        const reqObj = https.request(u, {method: opts.method || 'GET', headers}, response => {
            const chunks = [];
            response.on('data', c => chunks.push(c));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode >= 400) {
                    const err = new Error('Yandex HTTP ' + response.statusCode);
                    err.statusCode = response.statusCode;
                    err.body = text;
                    reject(err);
                    return;
                }
                resolve({status: response.statusCode, text});
            });
        });
        reqObj.setTimeout(12000, () => reqObj.destroy(new Error('Yandex request timeout')));
        reqObj.on('error', reject);
        if (body) reqObj.write(body);
        reqObj.end();
    });
}

async function apiJson(endpoint, opts) {
    const {text} = await apiRequest(endpoint, opts);
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        const err = new Error('Yandex invalid JSON: ' + endpoint);
        err.cause = e;
        throw err;
    }
    if (json && json.error) {
        const err = new Error('Yandex API error: ' + (json.error.message || json.error.name || 'unknown'));
        err.apiError = json.error;
        throw err;
    }
    return json && json.result !== undefined ? json.result : json;
}

// ---------- 映射 ----------
function coverUrl(uri, size) {
    if (!uri) return '';
    const px = Math.max(100, Math.min(1000, Number(size) || 400));
    // coverUri 形如 "avatars.yandex.net/get-music-content/.../%%"
    const clean = String(uri).replace(/%%$/, px + 'x' + px);
    return clean.startsWith('http') ? clean : 'https://' + clean;
}

function mapArtists(arr) {
    return (Array.isArray(arr) ? arr : [])
        .map(a => ({id: a && (a.id != null ? String(a.id) : ''), name: (a && a.name) || ''}))
        .filter(a => a.name);
}

function mapTrack(t) {
    t = t || {};
    // 搜索/歌单里 track 可能直接是 track 或包在 { track } 中
    if (t.track && (t.track.id || t.track.title)) t = t.track;
    const artists = mapArtists(t.artists);
    const album = (Array.isArray(t.albums) && t.albums[0]) || {};
    const id = t.id != null ? String(t.id) : (t.trackId != null ? String(t.trackId) : '');
    return {
        provider: 'yandex',
        source: 'yandex',
        type: 'yandex',
        id,
        yandexId: id,
        albumId: album.id != null ? String(album.id) : '',
        name: t.title || '',
        artist: artists.map(a => a.name).join(' / '),
        artists,
        artistId: artists[0] && artists[0].id,
        album: album.title || '',
        cover: coverUrl(t.coverUri || album.coverUri, 400),
        duration: Number(t.durationMs) || 0,
        fee: t.available === false ? 1 : 0,
        available: t.available !== false,
        playable: false,
    };
}

function mapPlaylist(pl) {
    pl = pl || {};
    const owner = pl.owner || {};
    return {
        provider: 'yandex',
        source: 'yandex',
        type: 'playlist',
        id: pl.kind != null ? String(pl.kind) : '',
        kind: pl.kind != null ? String(pl.kind) : '',
        ownerUid: owner.uid != null ? String(owner.uid) : '',
        name: pl.title || '',
        cover: coverUrl(pl.cover && (pl.cover.uri || (pl.cover.itemsUri && pl.cover.itemsUri[0])), 400),
        trackCount: Number(pl.trackCount) || 0,
        creator: owner.name || owner.login || '',
    };
}

// ---------- 业务 ----------
async function login(token) {
    saveToken(token);
    return getLoginInfo();
}

function logout() {
    saveToken('');
    return {provider: 'yandex', loggedIn: false};
}

async function getLoginInfo() {
    if (!hasToken()) return {provider: 'yandex', loggedIn: false};
    try {
        const result = await apiJson('/account/status');
        const account = (result && result.account) || {};
        cachedAccount = {
            uid: account.uid != null ? String(account.uid) : '',
            login: account.login || '',
            displayName: account.fullName || account.displayName || account.firstName || account.login || '',
            hasPlus: !!(result && result.plus && result.plus.hasPlus),
        };
        return {
            provider: 'yandex',
            loggedIn: !!cachedAccount.uid,
            userId: cachedAccount.uid,
            nickname: cachedAccount.displayName,
            avatar: '',
            hasPlus: cachedAccount.hasPlus,
        };
    } catch (e) {
        return {provider: 'yandex', loggedIn: false, error: e.message};
    }
}

async function ensureUid() {
    if (cachedAccount && cachedAccount.uid) return cachedAccount.uid;
    await getLoginInfo();
    return cachedAccount && cachedAccount.uid;
}

async function search(keywords, limit) {
    const kw = String(keywords || '').trim();
    if (!kw) return [];
    const cap = Math.max(1, Math.min(40, Number(limit) || 12));
    const params = new URLSearchParams({text: kw, type: 'track', page: '0', nocorrect: 'false'});
    const result = await apiJson('/search?' + params.toString());
    const tracks = (result && result.tracks && result.tracks.results) || [];
    const seen = new Set();
    return tracks
        .map(mapTrack)
        .filter(s => {
            if (!s.id || !s.name || seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        })
        .slice(0, cap);
}

async function trackUrl(trackId, qualityPreference) {
    const id = String(trackId || '').trim();
    if (!id) return {provider: 'yandex', url: '', playable: false, error: 'MISSING_TRACK_ID'};
    if (!hasToken()) return {provider: 'yandex', url: '', playable: false, error: 'LOGIN_REQUIRED', loggedIn: false};
    const infoList = await apiJson('/tracks/' + encodeURIComponent(id) + '/download-info');
    const mp3s = (Array.isArray(infoList) ? infoList : [])
        .filter(it => it && it.codec === 'mp3' && it.downloadInfoUrl)
        .sort((a, b) => (Number(b.bitrateInKbps) || 0) - (Number(a.bitrateInKbps) || 0));
    const wantLossless = /lossless|flac|hi-?res/i.test(String(qualityPreference || ''));
    const chosen = mp3s[0];
    if (!chosen) {
        return {
            provider: 'yandex',
            url: '',
            playable: false,
            error: 'YANDEX_URL_UNAVAILABLE',
            message: '该曲目无可用 mp3 下载源（可能需要 Plus 或区域受限）'
        };
    }
    const {text} = await apiRequest(chosen.downloadInfoUrl + '&format=json');
    let dl;
    try {
        dl = JSON.parse(text);
    } catch (e) {
        throw new Error('Yandex download-info JSON 解析失败');
    }
    const host = dl.host;
    const tsv = dl.ts;
    const p = dl.path;
    const s = dl.s;
    if (!host || !p || !tsv || !s) {
        return {provider: 'yandex', url: '', playable: false, error: 'YANDEX_SIGN_FAILED'};
    }
    const sign = crypto.createHash('md5').update(SIGN_SALT + String(p).slice(1) + s).digest('hex');
    const finalUrl = 'https://' + host + '/get-mp3/' + sign + '/' + tsv + p;
    return {
        provider: 'yandex',
        url: finalUrl,
        playable: true,
        trial: false,
        bitrate: Number(chosen.bitrateInKbps) || 0,
        level: 'mp3-' + (chosen.bitrateInKbps || '') + 'k',
        quality: (chosen.bitrateInKbps || '') + 'kbps mp3',
        requestedLossless: wantLossless,
    };
}

async function userPlaylists() {
    if (!hasToken()) return {provider: 'yandex', loggedIn: false, playlists: []};
    const uid = await ensureUid();
    if (!uid) return {provider: 'yandex', loggedIn: false, playlists: []};
    const result = await apiJson('/users/' + encodeURIComponent(uid) + '/playlists/list');
    const playlists = (Array.isArray(result) ? result : []).map(mapPlaylist).filter(p => p.id);
    // 「我喜欢的音乐」是 kind=3 的特殊歌单，单独补一个入口。
    const hasLiked = playlists.some(p => p.kind === '3');
    if (!hasLiked) {
        playlists.unshift({
            provider: 'yandex', source: 'yandex', type: 'playlist',
            id: '3', kind: '3', ownerUid: String(uid),
            name: 'Мне нравится', cover: '', trackCount: 0, creator: '',
        });
    }
    return {provider: 'yandex', loggedIn: true, playlists};
}

async function playlistTracks(kind, ownerUid) {
    const k = String(kind || '').trim();
    if (!k) return {provider: 'yandex', error: 'MISSING_KIND', tracks: []};
    const uid = String(ownerUid || '').trim() || await ensureUid();
    if (!uid) return {provider: 'yandex', loggedIn: false, error: 'LOGIN_REQUIRED', tracks: []};
    const result = await apiJson('/users/' + encodeURIComponent(uid) + '/playlists/' + encodeURIComponent(k));
    const rawTracks = (result && result.tracks) || [];
    const tracks = rawTracks.map(mapTrack).filter(t => t.id && t.name);
    return {
        provider: 'yandex',
        name: (result && result.title) || '',
        trackCount: (result && result.trackCount) || tracks.length,
        tracks,
    };
}

async function lyric(trackId) {
    // 歌词需要额外签名/接口，先返回空，后续里程碑接入。
    return {provider: 'yandex', id: String(trackId || ''), lyric: '', supported: false};
}

// Список id треков из «Мне нравится» (kind=3) — для синхронизации состояния лайков.
async function likedTrackIds() {
    if (!hasToken()) return [];
    const uid = await ensureUid();
    if (!uid) return [];
    const result = await apiJson('/users/' + encodeURIComponent(uid) + '/likes/tracks');
    const tracks = (result && result.library && result.library.tracks) || (result && result.tracks) || [];
    return (Array.isArray(tracks) ? tracks : [])
        .map(t => String(t && (t.id != null ? t.id : t.trackId != null ? t.trackId : t)))
        .filter(id => id && id !== 'undefined');
}

// Поставить/снять лайк (добавить/убрать из «Мне нравится»).
async function setLike(trackId, on) {
    const id = String(trackId || '').trim();
    if (!id) return {ok: false, error: 'MISSING_TRACK_ID'};
    if (!hasToken()) return {ok: false, error: 'LOGIN_REQUIRED'};
    const uid = await ensureUid();
    if (!uid) return {ok: false, error: 'LOGIN_REQUIRED'};
    const action = on ? 'add-multiple' : 'remove';
    await apiRequest('/users/' + encodeURIComponent(uid) + '/likes/tracks/' + action, {
        method: 'POST',
        body: {'track-ids': id},
    });
    return {ok: true, liked: !!on};
}

module.exports = {
    getToken,
    saveToken,
    hasToken,
    login,
    logout,
    getLoginInfo,
    search,
    trackUrl,
    userPlaylists,
    playlistTracks,
    lyric,
    likedTrackIds,
    setLike,
    coverUrl,
    mapTrack,
    TOKEN_FILE,
};
