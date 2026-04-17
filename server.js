const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// ── ROOMS ────────────────────────────────────────────────────────────────────
const rooms = {};
// wsInfo: Map<ws, { userId, userName, roomKey }>
const wsInfo = new Map();

function normalizeRoomName(n) { return n.trim().toLowerCase().replace(/\s+/g,' '); }
function getRoom(name) { return rooms[normalizeRoomName(name)] || null; }
function getRoomById(id) { return Object.values(rooms).find(r => r.id === id) || null; }

function createRoom(name, pass) {
  const key = normalizeRoomName(name);
  if (rooms[key]) return null;
  rooms[key] = {
    id: uuidv4().slice(0, 8),
    name: name.trim(), key, pass,
    hostName: null,           // userName of current host
    originalHostName: null,   // set once on first join, used for reclaim
    openControls: false,
    tracks: [],
    state: { trackIdx: 0, position: 0, playing: false, updatedAt: Date.now() },
    clients: new Set()
  };
  return rooms[key];
}

function broadcast(room, msg, exclude = null) {
  const data = JSON.stringify(msg);
  room.clients.forEach(ws => {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}
function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function roomPublicInfo(room) {
  const members = [];
  room.clients.forEach(ws => {
    const info = wsInfo.get(ws);
    if (info) members.push({ userId: info.userId, userName: info.userName, isHost: info.userName === room.hostName });
  });
  return {
    id: room.id, name: room.name,
    hostName: room.hostName,
    originalHostName: room.originalHostName,
    openControls: room.openControls,
    tracks: room.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })),
    state: room.state,
    listeners: room.clients.size,
    members
  };
}

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let currentRoom = null;
  let userId = uuidv4();
  let userName = 'Khách';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = currentRoom;

    // Helper: check if this ws is host
    const amHost = () => room && room.hostName === userName;
    // Check if allowed to control playback
    const canControl = () => room && (amHost() || room.openControls);

    switch (msg.type) {

      // ── JOIN ──────────────────────────────────────────
      case 'join': {
        let r = msg.roomId
          ? getRoomById(msg.roomId)
          : getRoom(msg.roomName);

        if (!r) { ws.send(JSON.stringify({ type: 'error', message: 'Phòng không tồn tại. Kiểm tra lại tên phòng.' })); return; }
        if (r.pass !== msg.pass) { ws.send(JSON.stringify({ type: 'error', message: 'Sai mật khẩu. Vui lòng thử lại.' })); return; }

        currentRoom = r;
        userId = uuidv4();
        userName = (msg.userName || 'Khách').trim();

        // Check duplicate name — allow if it's the originalHost reclaiming
        const isOriginalHostReclaim = userName === r.originalHostName;
        if (!isOriginalHostReclaim) {
          const nameInUse = [...r.clients].some(w => {
            const info = wsInfo.get(w);
            return info && info.userName.toLowerCase() === userName.toLowerCase();
          });
          if (nameInUse) {
            ws.send(JSON.stringify({ type: 'error', message: `Tên "${userName}" đã có người dùng trong phòng. Vui lòng chọn tên khác.` }));
            return;
          }
        }

        r.clients.add(ws);
        wsInfo.set(ws, { userId, userName, roomKey: r.key });

        // First joiner: become host and lock in as originalHost
        if (!r.originalHostName) {
          r.originalHostName = userName;
          r.hostName = userName;
        } else if (userName === r.originalHostName) {
          // Original host rejoining → reclaim immediately
          const prevHost = r.hostName;
          r.hostName = userName;
          if (prevHost !== userName) {
            // notify room the original host reclaimed
            broadcast(r, {
              type: 'host_changed',
              newHost: userName,
              members: roomPublicInfo(r).members,
              reason: `👑 ${userName} (chủ phòng gốc) đã vào lại và lấy lại quyền`
            }, ws);
          }
        }

        const info = roomPublicInfo(r);
        ws.send(JSON.stringify({ type: 'joined', room: info, userId, userName }));
        broadcast(r, { type: 'user_joined', userName, listeners: r.clients.size, members: info.members }, ws);
        break;
      }

      // ── PLAYBACK CONTROLS (with permission check) ────
      case 'play': {
        if (!room || !canControl()) { ws.send(JSON.stringify({ type: 'error', message: 'Bạn không có quyền điều khiển nhạc.' })); return; }
        room.state = { ...room.state, playing: true, position: msg.position || 0, trackIdx: msg.trackIdx ?? room.state.trackIdx, updatedAt: Date.now() };
        broadcast(room, { type: 'play', state: room.state }, ws);
        break;
      }
      case 'pause': {
        if (!room || !canControl()) { ws.send(JSON.stringify({ type: 'error', message: 'Bạn không có quyền điều khiển nhạc.' })); return; }
        room.state = { ...room.state, playing: false, position: msg.position || 0, updatedAt: Date.now() };
        broadcast(room, { type: 'pause', state: room.state }, ws);
        break;
      }
      case 'seek': {
        if (!room || !canControl()) return;
        room.state = { ...room.state, position: msg.position, updatedAt: Date.now() };
        broadcast(room, { type: 'seek', position: msg.position }, ws);
        break;
      }
      case 'next_track': {
        if (!room || !canControl()) { ws.send(JSON.stringify({ type: 'error', message: 'Bạn không có quyền chuyển bài.' })); return; }
        room.state = { trackIdx: msg.trackIdx, position: 0, playing: true, updatedAt: Date.now() };
        broadcastAll(room, { type: 'next_track', state: room.state });
        break;
      }
      case 'sync': {
        if (!room || !canControl()) return;
        room.state = { ...msg.state, updatedAt: Date.now() };
        broadcast(room, { type: 'sync', state: room.state }, ws);
        break;
      }

      // ── HOST ACTIONS ──────────────────────────────────
      case 'transfer_host': {
        if (!room || !amHost()) { ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng mới có thể chuyển quyền.' })); return; }
        const targetName = msg.targetUserName;
        let targetExists = false;
        room.clients.forEach(w => { const i = wsInfo.get(w); if (i && i.userName === targetName) targetExists = true; });
        if (!targetExists) { ws.send(JSON.stringify({ type: 'error', message: 'Người dùng không có trong phòng.' })); return; }
        room.hostName = targetName;
        broadcastAll(room, { type: 'host_changed', newHost: targetName, members: roomPublicInfo(room).members });
        break;
      }

      case 'reclaim_host': {
        // Only the original host (room creator) can reclaim at any time
        if (!room) return;
        if (userName !== room.originalHostName) {
          ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng gốc mới có thể lấy lại quyền.' }));
          return;
        }
        if (room.hostName === userName) return; // already host
        room.hostName = userName;
        broadcastAll(room, {
          type: 'host_changed',
          newHost: userName,
          members: roomPublicInfo(room).members,
          reason: `👑 ${userName} đã lấy lại quyền chủ phòng`
        });
        break;
      }

      case 'set_open_controls': {
        if (!room || !amHost()) { ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng mới có thể thay đổi quyền.' })); return; }
        room.openControls = !!msg.open;
        broadcastAll(room, { type: 'controls_changed', openControls: room.openControls });
        break;
      }

      // ── CHAT ──────────────────────────────────────────
      case 'chat': {
        if (!room) return;
        broadcast(room, { type: 'chat', userName, text: msg.text, ts: Date.now() }, ws);
        break;
      }
      case 'typing_start': { if (room) broadcast(room, { type: 'typing_start', userName }, ws); break; }
      case 'typing_stop':  { if (room) broadcast(room, { type: 'typing_stop',  userName }, ws); break; }

      case 'request_sync': {
        if (room) ws.send(JSON.stringify({ type: 'sync', state: room.state }));
        break;
      }

      case 'delete_room': {
        if (!room) return;
        if (!amHost()) { ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng mới có thể xóa phòng.' })); return; }
        // Notify all clients first, then clean up
        broadcastAll(room, { type: 'room_deleted', reason: `Chủ phòng "${userName}" đã xóa phòng này.` });
        // Clean up files and room
        room.tracks.forEach(t => { if (t.filePath && fs.existsSync(t.filePath)) { try { fs.unlinkSync(t.filePath); } catch(e){} } });
        // Remove all clients
        room.clients.forEach(w => { w.close(); });
        room.clients.clear();
        delete rooms[room.key];
        break;
      }

      case 'delete_track': {
        if (!room) return;
        if (!amHost()) { ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng mới có thể xóa bài.' })); return; }
        const tidx = room.tracks.findIndex(t => t.id === msg.trackId);
        if (tidx === -1) return;
        const [removed] = room.tracks.splice(tidx, 1);
        // delete file from disk
        if (removed.filePath && fs.existsSync(removed.filePath)) {
          try { fs.unlinkSync(removed.filePath); } catch(e) {}
        }
        // adjust current playing index if needed
        let newState = { ...room.state };
        if (room.state.trackIdx === tidx) {
          // deleted the currently playing track
          newState.trackIdx = Math.min(tidx, room.tracks.length - 1);
          newState.playing = false;
          newState.position = 0;
          newState.updatedAt = Date.now();
          room.state = newState;
        } else if (room.state.trackIdx > tidx) {
          newState.trackIdx = room.state.trackIdx - 1;
          newState.updatedAt = Date.now();
          room.state = newState;
        }
        broadcastAll(room, { type: 'track_deleted', trackId: msg.trackId, newState: room.state });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.clients.delete(ws);
      wsInfo.delete(ws);
      const wasHost = currentRoom.hostName === userName;

      // If host left → assign to next person in room
      if (wasHost && currentRoom.clients.size > 0) {
        const nextWs = [...currentRoom.clients][0];
        const nextInfo = wsInfo.get(nextWs);
        if (nextInfo) {
          currentRoom.hostName = nextInfo.userName;
          broadcastAll(currentRoom, {
            type: 'host_changed',
            newHost: currentRoom.hostName,
            members: roomPublicInfo(currentRoom).members,
            reason: `${userName} đã rời phòng, ${currentRoom.hostName} là chủ phòng mới`
          });
        }
      } else {
        broadcast(currentRoom, {
          type: 'user_left', userName,
          listeners: currentRoom.clients.size,
          members: roomPublicInfo(currentRoom).members
        });
      }

      if (currentRoom.clients.size === 0) {
        const roomKey = currentRoom.key;
        setTimeout(() => {
          const r = rooms[roomKey];
          if (r && r.clients.size === 0) {
            r.tracks.forEach(t => { if (t.filePath && fs.existsSync(t.filePath)) { try { fs.unlinkSync(t.filePath); } catch(e){} } });
            delete rooms[roomKey];
            console.log(`Room "${r.name}" auto-deleted after 3min empty`);
          }
        }, 3 * 60 * 1000);
      }
    }
  });
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file âm thanh'));
  }
});

app.post('/api/rooms', (req, res) => {
  const { name, pass } = req.body;
  if (!name || !pass) return res.status(400).json({ error: 'Thiếu tên phòng hoặc mật khẩu' });
  if (getRoom(name)) return res.status(409).json({ error: 'Tên phòng đã tồn tại, hãy chọn tên khác' });
  const room = createRoom(name, pass);
  res.json({ roomId: room.id, roomName: room.name });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  res.json(roomPublicInfo(room));
});

app.post('/api/rooms/:roomId/tracks', upload.single('file'), (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  const track = {
    id: uuidv4(),
    title: req.body.title || req.file.originalname.replace(/\.[^/.]+$/, ''),
    artist: req.body.artist || 'Chưa rõ',
    duration: req.body.duration || '–',
    size: req.file.size,
    filePath: req.file.path,
    fileName: req.file.filename
  };
  room.tracks.push(track);
  broadcastAll(room, { type: 'track_added', track: { id: track.id, title: track.title, artist: track.artist, duration: track.duration } });
  res.json({ trackId: track.id });
});

app.get('/api/rooms/:roomId/tracks/:trackId/stream', (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).end();
  const track = room.tracks.find(t => t.id === req.params.trackId);
  if (!track || !fs.existsSync(track.filePath)) return res.status(404).end();
  const stat = fs.statSync(track.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(track.filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(track.filePath).pipe(res);
  }
});

// Helper: fetch URL as text (follows redirects)
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 303) {
          return get(r.headers.location);
        }
        let d = '';
        r.setEncoding('utf8');
        r.on('data', c => d += c);
        r.on('end', () => resolve(d));
      }).on('error', reject);
    };
    get(url);
  });
}

// Parse file IDs from Drive folder HTML (no API key needed)
function parseDriveFolderHtml(html) {
  const files = [];
  // Drive embeds file metadata as JSON in the page — extract file IDs and names
  // Pattern: ["filename.mp3", null, null, null, null, ..., "FILE_ID"]
  const audioRe = /\["([^"]+\.(?:mp3|flac|wav|ogg|m4a|aac))"(?:[^\[\]]*?)"([A-Za-z0-9_-]{25,})"/gi;
  let m;
  while ((m = audioRe.exec(html)) !== null) {
    const name = m[1], id = m[2];
    if (!files.find(f => f.id === id)) files.push({ name, id });
  }
  // Fallback: look for data-id attributes with audio filenames nearby
  if (!files.length) {
    const idRe = /"([A-Za-z0-9_-]{33}[A-Za-z0-9_-]*)"/g;
    const nameRe = /([^"\s]+\.(?:mp3|flac|wav|ogg|m4a))/gi;
    const names = []; let nm;
    while ((nm = nameRe.exec(html)) !== null) names.push(nm[1]);
    const ids = []; let im;
    while ((im = idRe.exec(html)) !== null) ids.push(im[1]);
    names.forEach((name, i) => { if (ids[i]) files.push({ name, id: ids[i] }); });
  }
  return files;
}

app.post('/api/rooms/:roomId/drive-import', async (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  const { folderId } = req.body;
  if (!folderId) return res.status(400).json({ error: 'Thiếu folderId' });

  try {
    // ── Strategy 1: Google Drive API v3 with no key (works for truly public folders) ──
    // The /drive/v3/files endpoint allows listing public folder contents
    // without an API key when using the special resourceKey param
    const apiUrl = `https://www.googleapis.com/drive/v3/files` +
      `?q=%27${folderId}%27+in+parents` +
      `&fields=files(id%2Cname%2CmimeType)` +
      `&supportsAllDrives=true` +
      `&includeItemsFromAllDrives=true` +
      `&pageSize=100` +
      `&key=AIzaSyBA7DVGY-qMOovbQ2H4zM1bC3XJGVcUxAI`;

    let files = [];
    try {
      const apiResp = await fetchText(apiUrl);
      const data = JSON.parse(apiResp);
      if (data.files && data.files.length) {
        files = data.files.filter(f =>
          (f.mimeType && f.mimeType.startsWith('audio/')) ||
          /\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(f.name)
        );
        console.log(`Drive API: found ${files.length} audio files`);
      }
    } catch(e) {
      console.log('Drive API failed, trying HTML parse:', e.message);
    }

    // ── Strategy 2: Parse folder HTML page (fallback, no API key needed) ──
    if (!files.length) {
      try {
        const html = await fetchText(`https://drive.google.com/drive/folders/${folderId}`);
        const parsed = parseDriveFolderHtml(html);
        files = parsed.map(f => ({ id: f.id, name: f.name }));
        console.log(`HTML parse: found ${files.length} audio files`);
      } catch(e) {
        console.log('HTML parse failed:', e.message);
      }
    }

    if (!files.length) {
      return res.status(400).json({
        error: 'Không tìm thấy file nhạc. Đảm bảo folder được chia sẻ "Anyone with the link" và có chứa file .mp3'
      });
    }

    // ── Download each file ──
    let count = 0;
    const errors = [];
    for (const f of files) {
      const destPath = path.join(UPLOAD_DIR, uuidv4() + '.mp3');
      try {
        // Try direct download URL first, then export URL
        const dlUrl = `https://drive.google.com/uc?export=download&id=${f.id}&confirm=t`;
        await downloadFile(dlUrl, destPath);

        const stat = fs.statSync(destPath);
        if (stat.size < 10000) {
          // File too small — likely a redirect/error page, not actual audio
          fs.unlinkSync(destPath);
          errors.push(f.name + ' (download bị chặn)');
          continue;
        }

        const base = f.name.replace(/\.[^/.]+$/, '');
        const parts = base.split(/\s*[-–—]\s*/);
        let title = base, artist = 'Chưa rõ';
        if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }

        const track = { id: uuidv4(), title, artist, duration: '–', size: stat.size, filePath: destPath, fileName: path.basename(destPath) };
        room.tracks.push(track);
        broadcastAll(room, { type: 'track_added', track: { id: track.id, title: track.title, artist: track.artist, duration: track.duration } });
        count++;
      } catch(e) {
        console.error('Download error:', f.name, e.message);
        errors.push(f.name);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch(e2) {}
      }
    }

    res.json({
      count,
      total: files.length,
      errors: errors.length ? errors : undefined,
      message: count > 0
        ? `Đã import ${count}/${files.length} bài thành công`
        : 'Không tải được file nào. Google Drive có thể đang chặn download hàng loạt.'
    });
  } catch(e) {
    console.error('Drive import error:', e);
    res.status(500).json({ error: 'Lỗi server: ' + e.message });
  }
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302) { file.close(); return get(r.headers.location); }
        if (r.statusCode !== 200) { file.close(); fs.unlink(dest,()=>{}); return reject(new Error('HTTP '+r.statusCode)); }
        r.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { fs.unlink(dest,()=>{}); reject(e); });
    };
    get(url);
  });
}

// List active rooms (no sensitive info — no pass, no file paths)
app.get('/api/rooms', (req, res) => {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    listeners: r.clients.size,
    trackCount: r.tracks.length,
    hasMusic: r.tracks.length > 0,
    nowPlaying: r.tracks[r.state.trackIdx]
      ? { title: r.tracks[r.state.trackIdx].title, artist: r.tracks[r.state.trackIdx].artist }
      : null,
    playing: r.state.playing
  }));
  res.json(list);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`Mu6ly chạy tại http://localhost:${PORT}`));
