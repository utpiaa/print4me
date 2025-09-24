# Print4me Server

Node/Express backend for the Print4me mobile app. Accepts printable files and user info, then emails the admin with the request details and attachments.

## Features
- Upload up to 5 files (PDF, Word DOC/DOCX, images JPEG/PNG/GIF/WebP/BMP/HEIC/HEIF), 25MB each.
- Collects: name, Egypt mobile number, delivery address, optional notes.
- Validates Egyptian mobile formats (e.g. `010xxxxxxxx`, `+2010xxxxxxxx`, `2010xxxxxxxx`, `002010xxxxxxxx`).
- Sends an email to the admin with attachments using Nodemailer via SMTP or Gmail App Password.

## Requirements
- Node.js 18+
- An SMTP account OR Gmail account with 2FA and App Password.

## Setup
1. Install dependencies
```bash
npm install
```

2. Create `.env` from template and fill values
```bash
cp .env.example .env
# On Windows PowerShell
# cp might not exist; use:
# Copy-Item .env.example .env
```

Edit `.env` and set at minimum:
- `ADMIN_EMAIL=abdelhai.atiia@gmail.com` (already set by default)
- Either SMTP_* values, or `GMAIL_USER` and `GMAIL_APP_PASSWORD`.

3. Run in development
```bash
npm run dev
```

Server will listen at `http://localhost:4000`.

## API
### POST /api/print-request
Multipart form upload.

Fields:
- `name` (text)
- `mobile` (text, Egypt formats)
- `address` (text)
- `notes` (text, optional)
- `files` (one or more file inputs)

Example (PowerShell using `curl.exe`):
```powershell
curl.exe -X POST http://localhost:4000/api/print-request \
  -F "name=Ahmed Ali" \
  -F "mobile=+201234567890" \
  -F "address=Cairo, Nasr City" \
  -F "notes=Please print in color" \
  -F "files=@C:\\path\\to\\document.pdf"
```

Response:
```json
{ "ok": true, "messageId": "<...>" }
```

On validation error:
```json
{ "ok": false, "errors": ["..."] }
```

## Notes
- Uploaded files are stored temporarily under `server/uploads/` and deleted after email is sent.
- Adjust allowed MIME types or size limits in `src/index.js` if needed.
