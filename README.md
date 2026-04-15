# 🎵 Mu6ly — Nghe nhạc cùng nhau

Web app nghe nhạc realtime nhiều người, sync WebSocket.

## Tính năng
- Tạo phòng / vào phòng bằng mã 8 ký tự
- Chủ phòng upload nhạc (.mp3, .flac, .wav...) — mọi người cùng nghe
- Play/pause/seek đồng bộ realtime qua WebSocket
- Chat trong phòng
- Chia sẻ phòng bằng link `/?room=ROOM_CODE`

---

## Deploy lên Railway (miễn phí, dễ nhất)

### Bước 1 — Tạo tài khoản
Vào [railway.app](https://railway.app) → đăng ký bằng GitHub

### Bước 2 — Upload code
1. Tạo tài khoản [github.com](https://github.com) nếu chưa có
2. Tạo repo mới (private hoặc public)
3. Upload toàn bộ thư mục này lên repo

### Bước 3 — Deploy
1. Vào Railway → **New Project → Deploy from GitHub repo**
2. Chọn repo vừa tạo
3. Railway tự nhận `package.json` và chạy `npm start`
4. Sau ~1 phút → vào **Settings → Domains → Generate Domain**
5. Bạn có link dạng `https://mu6ly-xxx.up.railway.app`

---

## Deploy lên Render (miễn phí, ngủ sau 15 phút không dùng)

1. Vào [render.com](https://render.com) → New → Web Service
2. Kết nối GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Free tier → Deploy

---

## Chạy local (để test)

```bash
npm install
npm start
# Mở http://localhost:3000
```

---

## Cách dùng

1. **Chủ phòng** vào web → Tạo phòng → đặt tên → nhận mã phòng 8 ký tự
2. **Chia sẻ link** cho bạn bè: `https://your-domain.com/?room=MAPHONG`
3. Chủ phòng nhấn **+ Thêm nhạc** để upload file
4. Nhấn play → tất cả mọi người nghe cùng lúc, đồng bộ realtime

---

## Giới hạn free tier

| Service | RAM | Bandwidth | Lưu ý |
|---------|-----|-----------|-------|
| Railway | 512MB | 100GB/tháng | Không ngủ |
| Render | 512MB | 100GB/tháng | Ngủ sau 15p |

File nhạc lưu tạm trong RAM/disk của server, tự xóa khi phòng trống 10 phút.
Với free tier nên tránh file quá lớn (>20MB/bài).
