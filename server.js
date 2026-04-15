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
        // Only current host can transfer
        if (!room || !amHost()) { ws.send(JSON.stringify({ type: 'error', message: 'Chỉ chủ phòng mới có thể chuyển quyền.' })); return; }
        const targetName = msg.targetUserName;
        // Verify target is in room
        let targetExists = false;
        room.clients.forEach(w => { const i = wsInfo.get(w); if (i && i.userName === targetName) targetExists = true; });
        if (!targetExists) { ws.send(JSON.stringify({ type: 'error', message: 'Người dùng không có trong phòng.' })); return; }
        room.hostName = targetName;
        broadcastAll(room, { type: 'host_changed', newHost: targetName, members: roomPublicInfo(room).members });
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
        setTimeout(() => {
          if (currentRoom && currentRoom.clients.size === 0) {
            currentRoom.tracks.forEach(t => { if (t.filePath && fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath); });
            delete rooms[currentRoom.key];
          }
        }, 10 * 60 * 1000);
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

app.post('/api/rooms/:roomId/drive-import', async (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  const { folderId } = req.body;
  if (!folderId) return res.status(400).json({ error: 'Thiếu folderId' });
  try {
    const https = require('https');
    const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType+contains+'audio'&fields=files(id,name,mimeType)&key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY`;
    const fetchJson = (url) => new Promise((resolve, reject) => {
      https.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d))}catch{reject(new Error('parse'))}}); }).on('error',reject);
    });
    const driveData = await fetchJson(apiUrl);
    if (driveData.error) return res.status(400).json({ error: 'Không đọc được folder. Kiểm tra folder đã public chưa.' });
    const files = (driveData.files||[]).filter(f => f.mimeType.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a)$/i.test(f.name));
    if (!files.length) return res.json({ count: 0 });
    let count = 0;
    for (const f of files) {
      const destPath = path.join(UPLOAD_DIR, uuidv4() + '.mp3');
      try {
        await downloadFile(`https://drive.google.com/uc?export=download&id=${f.id}`, destPath);
        const base = f.name.replace(/\.[^/.]+$/,'');
        const parts = base.split(/\s*[-–—]\s*/);
        let title = base, artist = 'Chưa rõ';
        if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
        const track = { id: uuidv4(), title, artist, duration: '–', size: 0, filePath: destPath, fileName: path.basename(destPath) };
        room.tracks.push(track);
        broadcastAll(room, { type: 'track_added', track: { id: track.id, title: track.title, artist: track.artist, duration: track.duration } });
        count++;
      } catch(e) { console.error('Drive download error:', f.name, e.message); }
    }
    res.json({ count });
  } catch(e) { res.status(500).json({ error: 'Lỗi server: ' + e.message }); }
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
