require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4000;

// Configurable CORS: use ALLOWED_ORIGINS env (comma-separated). Defaults to '*'.
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const corsOptions = allowedOriginsEnv
  ? {
      origin: (origin, cb) => {
        // allow mobile apps (no origin) and CLI tools
        if (!origin) return cb(null, true);
        const list = allowedOriginsEnv.split(',').map((s) => s.trim());
        cb(null, list.includes(origin));
      },
    }
  : { origin: '*' };
app.use(cors(corsOptions));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'print4me-server' });
});


// Root route - helpful message
app.get('/', (req, res) => {
  res.type('text').send('Print4me server is running. Use GET /health or POST /api/print-request');
});

// Storage setup for uploads
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, uniqueSuffix + '-' + safeOriginal);
  },
});

const allowedMimeTypes = new Set([
  // PDFs
  'application/pdf',
  // Word (doc, docx)
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/heic',
  'image/heif',
]);

const fileFilter = (req, file, cb) => {
  const mimetype = file.mimetype || '';
  const ext = (file.originalname || '').toLowerCase();
  const byMime = allowedMimeTypes.has(mimetype) || mimetype === 'application/octet-stream';
  const byExt = /\.(pdf|doc|docx|jpg|jpeg|png|gif|webp|bmp|heic|heif)$/i.test(ext);
  if (byMime || byExt) return cb(null, true);
  cb(new Error('Unsupported file type: ' + mimetype + ' for ' + file.originalname));
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per file
    files: 5, // limit number of files per request
  },
});

// Count one file endpoint (useful for clients that upload one at a time)
app.post('/api/count-one', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file is required' });
  try {
    const f = req.file;
    try { console.log('count-one received', { name: f.originalname, mimetype: f.mimetype, size: f.size, path: f.path }); } catch(_) {}
    const pages = await getFilePageCount(f);
    try { fs.unlinkSync(f.path); } catch (_) {}
    return res.json({ ok: true, pages, originalName: f.originalname, mimetype: f.mimetype });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Utility to get page count for supported types
async function getFilePageCount(file) {
  try {
    const ext = (file.originalname || '').toLowerCase();
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(ext)) {
      const dataBuffer = fs.readFileSync(file.path);
      // Try pdf-parse first
      try {
        const pdfParse = require('pdf-parse');
        const parsed = await pdfParse(dataBuffer);
        if (parsed && parsed.numpages) return parsed.numpages;
      } catch (e1) {
        console.warn('pdf-parse failed for', file.originalname, e1.message);
      }
      // Fallback to pdf-lib
      try {
        const { PDFDocument } = require('pdf-lib');
        const doc = await PDFDocument.load(dataBuffer, { ignoreEncryption: true });
        const count = doc.getPageCount();
        if (count) return count;
      } catch (e2) {
        console.warn('pdf-lib fallback failed for', file.originalname, e2.message);
      }
      return 0;
    }
    // Each image or unsupported type counts as 1 page by convention
    return 1;
  } catch (e) {
    console.error('Page count error for', file.originalname, e.message);
    return 0;
  }
}

// Count pages endpoint
app.post('/api/count-pages', upload.array('files', 5), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ ok: false, error: 'At least one file is required' });
  }
  try {
    const results = [];
    let totalPages = 0;
    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      try { console.log('count-pages received', { i, name: f.originalname, mimetype: f.mimetype, size: f.size, path: f.path }); } catch(_) {}
      const pages = await getFilePageCount(f);
      totalPages += pages;
      results.push({ index: i, originalName: f.originalname, mimetype: f.mimetype, pages });
    }
    // Clean up temp files
    for (const f of req.files) {
      try { fs.unlinkSync(f.path); } catch (_) {}
    }
    return res.json({ ok: true, totalPages, files: results });
  } catch (err) {
    // Clean up on error too
    if (req.files) {
      for (const f of req.files) {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Egyptian mobile number validation: +20, 0020, 0, or no prefix followed by 1[0,1,2,5] and 8 digits
function isValidEgyptMobile(mobile) {
  if (!mobile) return false;
  const trimmed = String(mobile).replace(/\s|-/g, '');
  // Accept formats like: 010xxxxxxxx, +2010xxxxxxxx, 2010xxxxxxxx, 002010xxxxxxxx
  const patterns = [
    /^(?:\+?20|0020|0)?1[0125]\d{8}$/,
  ];
  return patterns.some((re) => re.test(trimmed));
}

function required(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function buildTransport() {
  // If SMTP details provided, use them (recommended)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const secure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 60000,
    });
  }
  // Fallback: try Gmail with app password if provided in ENV
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 60000,
    });
  }
  throw new Error('Email transport is not configured. Provide SMTP_* or GMAIL_USER/GMAIL_APP_PASSWORD in .env');
}

app.post('/api/print-request', upload.array('files', 5), async (req, res) => {
  const { name, mobile, address, notes, colorMode, paperSize, sides, copies, pages, filesMeta } = req.body;

  // Basic validations
  const errors = [];
  if (!required(name)) errors.push('Name is required');
  if (!required(mobile) || !isValidEgyptMobile(mobile)) errors.push('Valid Egypt mobile number is required');
  if (!required(address)) errors.push('Delivery address is required');
  if (!req.files || req.files.length === 0) errors.push('At least one file is required');

  // Print options validation
  const allowedColor = new Set(['color', 'bw']);
  const allowedSizes = new Set(['A4', 'A3']);
  const allowedSides = new Set(['single', 'double']);
  const copiesNum = copies !== undefined ? Number(copies) : 1;

  if (colorMode && !allowedColor.has(String(colorMode))) errors.push('colorMode must be one of: color, bw');
  if (paperSize && !allowedSizes.has(String(paperSize))) errors.push('paperSize must be one of: A4, A3');
  if (sides && !allowedSides.has(String(sides))) errors.push('sides must be one of: single, double');
  if (Number.isNaN(copiesNum) || copiesNum < 1 || copiesNum > 100) errors.push('copies must be an integer between 1 and 100');

  // Parse client-provided filesMeta describing PDF ranges by original name
  let metaList = [];
  if (filesMeta) {
    try {
      metaList = JSON.parse(filesMeta);
      if (!Array.isArray(metaList)) metaList = [];
    } catch (_) {
      // ignore malformed meta
      metaList = [];
    }
  }
  // meta by index (position in the upload array)
  const metaByIndex = new Map(metaList.map((m) => [Number(m.index), m]));

  // Determine pages per file using server-side parsing (source of truth)
  const perFile = [];
  for (let i = 0; i < (req.files || []).length; i++) {
    const f = req.files[i];
    try { console.log('print-request received', { i, name: f.originalname, mimetype: f.mimetype, size: f.size, path: f.path }); } catch(_) {}
    const totalInFile = await getFilePageCount(f);
    let usedPages = totalInFile;
    const m = metaByIndex.get(i);
    if (m && m.isPdf && m.selectMode === 'range') {
      const from = Math.max(1, Math.min(totalInFile, Number(m.rangeFrom || 1)));
      const to = Math.max(1, Math.min(totalInFile, Number(m.rangeTo || totalInFile)));
      usedPages = Math.max(0, to - from + 1);
    }
    // For non-PDFs, default to 1 page if detection failed
    if (f.mimetype !== 'application/pdf' && (!usedPages || Number.isNaN(usedPages))) {
      usedPages = 1;
    }
    perFile.push({ index: i, name: f.originalname, mimetype: f.mimetype, totalInFile, usedPages, range: metaByIndex.get(i) });
  }
  const pagesNum = perFile.reduce((s, it) => s + (Number(it.usedPages) || 0), 0);
  if (!pagesNum || pagesNum < 1 || pagesNum > 10000) errors.push('Could not determine total pages from uploaded files');

  // Compute estimated price (EGP)
  function unitPriceEGP(mode, sd) {
    const m = (mode || 'color');
    const s = (sd || 'single');
    if (m === 'bw' && s === 'single') return 1.0;
    if (m === 'bw' && s === 'double') return 1.5;
    if (m === 'color' && s === 'single') return 5.0;
    if (m === 'color' && s === 'double') return 7.0;
    return 1.0;
  }
  const unit = unitPriceEGP(colorMode, sides);
  const estimatedTotal = Number((unit * pagesNum * copiesNum).toFixed(2));
  const priceBreakdown = `EGP ${unit} × ${pagesNum} pages × ${copiesNum} copies = EGP ${estimatedTotal}`;

  if (errors.length > 0) {
    // Clean up uploaded temp files if validation fails
    if (req.files) {
      for (const f of req.files) {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
    }
    return res.status(400).json({ ok: false, errors });
  }

  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) throw new Error('ADMIN_EMAIL is not set');

    const transporter = buildTransport();

    const subject = `Print4me - New Print Request from ${name}`;
    const text = `You have a new print request.\n\n` +
      `Name: ${name}\n` +
      `Mobile: ${mobile}\n` +
      `Address: ${address}\n` +
      `Color Mode: ${colorMode || 'color'}\n` +
      `Paper Size: ${paperSize || 'A4'}\n` +
      `Sides: ${sides || 'single'}\n` +
      `Copies: ${copiesNum}\n` +
      `Pages: ${pagesNum}\n` +
      `Estimated Total: EGP ${estimatedTotal}\n` +
      `Breakdown: ${priceBreakdown}\n` +
      (notes ? `Notes: ${notes}\n` : '') +
      `Files: ${req.files.map(f => f.originalname).join(', ')}`;

    const html = `
      <h2>New Print Request</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Mobile:</strong> ${escapeHtml(mobile)}</p>
      <p><strong>Address:</strong> ${escapeHtml(address)}</p>
      <p><strong>Color Mode:</strong> ${escapeHtml(colorMode || 'color')}</p>
      <p><strong>Paper Size:</strong> ${escapeHtml(paperSize || 'A4')}</p>
      <p><strong>Sides:</strong> ${escapeHtml(sides || 'single')}</p>
      <p><strong>Copies:</strong> ${escapeHtml(String(copiesNum))}</p>
      <p><strong>Pages:</strong> ${escapeHtml(String(pagesNum))}</p>
      <p><strong>Estimated Total:</strong> EGP ${escapeHtml(String(estimatedTotal))}</p>
      <p><strong>Breakdown:</strong> ${escapeHtml(priceBreakdown)}</p>
      ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ''}
      <p><strong>Files:</strong></p>
      <ul>
        ${perFile.map(p => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.mimetype)} — pages used: ${escapeHtml(String(p.usedPages))}${p.range && p.range.selectMode==='range' ? ` (range ${escapeHtml(String(p.range.rangeFrom))}-${escapeHtml(String(p.range.rangeTo))})` : ''}</li>`).join('')}
      </ul>
    `;

    // Decide whether to attach files based on combined size
    const combinedSize = (req.files || []).reduce((s, f) => s + (Number(f.size) || 0), 0);
    const ATTACHMENT_LIMIT = Number(process.env.ATTACHMENT_LIMIT_BYTES || 20 * 1024 * 1024); // 20MB
    let attachments = [];
    let noteTooLarge = '';
    if (combinedSize <= ATTACHMENT_LIMIT) {
      attachments = req.files.map((f) => ({ filename: f.originalname, path: f.path }));
    } else {
      noteTooLarge = `\n\n[Note] Attachments not included (combined size ${(combinedSize/1024/1024).toFixed(1)}MB exceeds limit).`;
    }

    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER || process.env.GMAIL_USER;

    // Respond to client immediately to avoid timeout
    try { console.log('print-request queued email send', { filesCount: req.files.length, combinedSize }); } catch(_) {}
    res.json({ ok: true, queued: true, pages: pagesNum, estimatedTotal });

    // Send email in background and clean up
    setImmediate(async () => {
      try {
        const info = await transporter.sendMail({
          from: fromEmail,
          to: adminEmail,
          subject,
          text: text + noteTooLarge,
          html: html + (noteTooLarge ? `<p><em>${escapeHtml(noteTooLarge)}</em></p>` : ''),
          attachments,
        });
        try { console.log('print-request email sent', { messageId: info.messageId }); } catch(_) {}
      } catch (err) {
        console.error('Email send error (background):', err);
      } finally {
        if (req.files) {
          for (const f of req.files) {
            try { fs.unlinkSync(f.path); } catch (_) {}
          }
        }
      }
    });
  } catch (err) {
    console.error('Email prepare error:', err);
    // Clean up files on error
    if (req.files) {
      for (const f of req.files) {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
    }
    // Only respond if not already sent
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

// Simple HTML escaping
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Print4me server listening on http://0.0.0.0:${PORT}`);
});
