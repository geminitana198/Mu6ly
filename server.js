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

// rooms keyed by normalized name
const rooms = {};

function normalizeRoomName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getRoom(name) {
  return rooms[normalizeRoomName(name)] || null;
}

function createRoom(name, pass) {
  const key = normalizeRoomName(name);
  if (rooms[key]) return null; // already exists
  const room = {
    id: uuidv4().slice(0, 8),
    name: name.trim(),
    key,
    pass,
    tracks: [],
    state: { trackIdx: 0, position: 0, playing: false, updatedAt: Date.now() },
    clients: new Set()
  };
  rooms[key] = room;
  return room;
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

function roomInfo(room) {
  return {
    id: room.id, name: room.name,
    tracks: room.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, size: t.size })),
    state: room.state,
    listeners: room.clients.size
  };
}

// ── WEBSOCKET ─────────────────────────────────────────
wss.on('connection', (ws) => {
  let currentRoom = null;
  let userId = uuidv4();
  let userName = 'Khách';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        // Host creates room, guests join by name+pass
        let room;
        if (msg.roomId) {
          // Host rejoining by ID (internal use)
          room = Object.values(rooms).find(r => r.id === msg.roomId);
        } else {
          room = getRoom(msg.roomName);
        }

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Phòng không tồn tại. Kiểm tra lại tên phòng.' }));
          return;
        }
        if (room.pass !== msg.pass) {
          ws.send(JSON.stringify({ type: 'error', message: 'Sai mật khẩu. Vui lòng thử lại.' }));
          return;
        }

        currentRoom = room;
        userId = uuidv4();
        userName = msg.userName || ('Khách ' + Math.floor(Math.random() * 9000 + 1000));
        room.clients.add(ws);

        ws.send(JSON.stringify({ type: 'joined', room: roomInfo(room), userId, userName }));
        broadcast(room, { type: 'user_joined', userName, listeners: room.clients.size }, ws);
        break;
      }

      case 'sync': {
        // Host sends current playback state
        if (!currentRoom) return;
        currentRoom.state = { ...msg.state, updatedAt: Date.now() };
        broadcast(currentRoom, { type: 'sync', state: currentRoom.state }, ws);
        break;
      }

      case 'play': {
        if (!currentRoom) return;
        currentRoom.state.playing = true;
        currentRoom.state.position = msg.position || 0;
        currentRoom.state.trackIdx = msg.trackIdx ?? currentRoom.state.trackIdx;
        currentRoom.state.updatedAt = Date.now();
        broadcast(currentRoom, { type: 'play', state: currentRoom.state }, ws);
        break;
      }

      case 'pause': {
        if (!currentRoom) return;
        currentRoom.state.playing = false;
        currentRoom.state.position = msg.position || 0;
        currentRoom.state.updatedAt = Date.now();
        broadcast(currentRoom, { type: 'pause', state: currentRoom.state }, ws);
        break;
      }

      case 'seek': {
        if (!currentRoom) return;
        currentRoom.state.position = msg.position;
        currentRoom.state.updatedAt = Date.now();
        broadcast(currentRoom, { type: 'seek', position: msg.position }, ws);
        break;
      }

      case 'next_track': {
        if (!currentRoom) return;
        currentRoom.state.trackIdx = msg.trackIdx;
        currentRoom.state.position = 0;
        currentRoom.state.playing = true;
        currentRoom.state.updatedAt = Date.now();
        broadcastAll(currentRoom, { type: 'next_track', state: currentRoom.state });
        break;
      }

      case 'chat': {
        if (!currentRoom) return;
        // Broadcast to others only — sender already shows message locally
        broadcast(currentRoom, { type: 'chat', userName, text: msg.text, ts: Date.now() }, ws);
        break;
      }

      case 'typing_start': {
        if (!currentRoom) return;
        broadcast(currentRoom, { type: 'typing_start', userName }, ws);
        break;
      }

      case 'typing_stop': {
        if (!currentRoom) return;
        broadcast(currentRoom, { type: 'typing_stop', userName }, ws);
        break;
      }

      case 'request_sync': {
        // New listener asks for current state
        if (!currentRoom) return;
        ws.send(JSON.stringify({ type: 'sync', state: currentRoom.state }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.clients.delete(ws);
      broadcast(currentRoom, { type: 'user_left', userName, listeners: currentRoom.clients.size });
      // Clean up empty rooms after 10 min
      if (currentRoom.clients.size === 0) {
        setTimeout(() => {
          if (currentRoom && currentRoom.clients.size === 0) {
            currentRoom.tracks.forEach(t => {
              if (t.filePath && fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath);
            });
            delete rooms[currentRoom.key];
          }
        }, 10 * 60 * 1000);
      }
    }
  });
});

// ── REST API ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(file.originalname))
      cb(null, true);
    else cb(new Error('Chỉ chấp nhận file âm thanh'));
  }
});

// Create room
app.post('/api/rooms', (req, res) => {
  const { name, pass } = req.body;
  if (!name || !pass) return res.status(400).json({ error: 'Thiếu tên phòng hoặc mật khẩu' });
  const existing = getRoom(name);
  if (existing) return res.status(409).json({ error: 'Tên phòng đã tồn tại, hãy chọn tên khác' });
  const room = createRoom(name, pass);
  res.json({ roomId: room.id, roomName: room.name });
});

function getRoomById(id) {
  return Object.values(rooms).find(r => r.id === id) || null;
}

// Get room info
app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  res.json(roomInfo(room));
});

// Upload track to room
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

// Stream audio
app.get('/api/rooms/:roomId/tracks/:trackId/stream', (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).end();
  const track = room.tracks.find(t => t.id === req.params.trackId);
  if (!track || !fs.existsSync(track.filePath)) return res.status(404).end();

  const stat = fs.statSync(track.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg',
    });
    fs.createReadStream(track.filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(track.filePath).pipe(res);
  }
});

// Import tracks from public Google Drive folder
app.post('/api/rooms/:roomId/drive-import', async (req, res) => {
  const room = getRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Phòng không tồn tại' });
  const { folderId } = req.body;
  if (!folderId) return res.status(400).json({ error: 'Thiếu folderId' });

  try {
    // Use Drive API v3 public endpoint (no API key needed for public folders)
    const https = require('https');
    const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType+contains+'audio'&fields=files(id,name,mimeType)&key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY`;

    const fetchJson = (url) => new Promise((resolve, reject) => {
      https.get(url, (r) => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
      }).on('error', reject);
    });

    const driveData = await fetchJson(apiUrl);
    if (driveData.error) {
      return res.status(400).json({ error: 'Không đọc được folder. Kiểm tra folder đã public chưa, hoặc dùng Google API Key của bạn.' });
    }

    const files = (driveData.files || []).filter(f =>
      f.mimeType.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a)$/i.test(f.name)
    );

    if (!files.length) return res.json({ count: 0, message: 'Không tìm thấy file nhạc trong folder' });

    // Download each file and add to room
    let count = 0;
    for (const f of files) {
      const dlUrl = `https://drive.google.com/uc?export=download&id=${f.id}`;
      const destPath = path.join(UPLOAD_DIR, uuidv4() + '.mp3');

      try {
        await downloadFile(dlUrl, destPath);
        const base = f.name.replace(/\.[^/.]+$/, '');
        const parts = base.split(/\s*[-–—]\s*/);
        let title = base, artist = 'Chưa rõ';
        if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }

        const track = { id: uuidv4(), title, artist, duration: '–', size: 0, filePath: destPath, fileName: path.basename(destPath) };
        room.tracks.push(track);
        broadcastAll(room, { type: 'track_added', track: { id: track.id, title: track.title, artist: track.artist, duration: track.duration } });
        count++;
      } catch (e) {
        console.error('Download error:', f.name, e.message);
      }
    }
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi server: ' + e.message });
  }
});

function downloadFile(url, dest) {
  const https = require('https');
  const http = require('http');
  const fs2 = require('fs');
  return new Promise((resolve, reject) => {
    const file = fs2.createWriteStream(dest);
    const get = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close(); return get(res.headers.location);
        }
        if (res.statusCode !== 200) { file.close(); fs2.unlink(dest, () => {}); return reject(new Error('HTTP ' + res.statusCode)); }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { fs2.unlink(dest, () => {}); reject(e); });
    };
    get(url);
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`Mu6ly chạy tại http://localhost:${PORT}`));
