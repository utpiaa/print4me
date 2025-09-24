# Print4me (MVP)

A simple mobile + backend solution to collect print requests from users. Users select files (PDF/Word/Images), enter their name, Egypt mobile number, and delivery address. The server emails the request with attachments to the admin.

- Mobile app: Expo React Native (SDK 54)
- Backend: Node.js/Express with Multer + Nodemailer

## Project Structure
- `client/` — Expo app (`App.js`) with file picker and upload form
- `server/` — Express API (`src/index.js`) to receive uploads and email admin

## Getting Started

### 1) Backend
- Copy `server/.env.example` to `server/.env` and fill values. For Gmail + App Password:
```
PORT=4000
ADMIN_EMAIL=<where to receive notifications>
GMAIL_USER=<your_gmail>
GMAIL_APP_PASSWORD=<16-char app password>
```
- Install and run:
```powershell
# In server/
npm install
node src/index.js  # or: npm run dev (if PATH has node)
```
- Health check: http://localhost:4000/health

### 2) Mobile app
- Update `client/app.json` → `expo.extra.apiBaseUrl` to point to your backend:
  - Android emulator: `http://10.0.2.2:4000`
  - iOS simulator: `http://localhost:4000`
  - Physical device: `http://<your_pc_lan_ip>:4000`
- Install and start:
```powershell
# In client/
npm install
npx expo start --lan
```
- Open the project in Expo Go (Android/iOS). Ensure device and PC are on the same network.

## API
- `POST /api/print-request`
  - Multipart form fields: `name`, `mobile`, `address`, `notes?`, `files` (1–5 files)
  - Allowed: PDF, DOC/DOCX, images (jpeg/png/gif/webp/bmp/heic/heif). Max 25MB/file.

## Production Notes
- Use an SMTP provider (or Gmail app password) dedicated for sending.
- Consider file antivirus scanning and persistent storage if you need to keep uploaded files.
- Add rate limiting and CORS origin allowlist.
- For publishing a standalone app, use Expo EAS Build:
  - https://docs.expo.dev/build/introduction/
  - Android APK/AAB and iOS IPA generation requires accounts and signing.

## Troubleshooting
- Expo Go compatibility: ensure the app uses a matching Expo SDK version (currently 54).
- If Expo fails to open on device, try `--clear --lan` or Tunnel mode.
- If the device can't reach the backend, verify the LAN IP and firewall rules. Test http://<pc_ip>:4000/health from the device browser.
