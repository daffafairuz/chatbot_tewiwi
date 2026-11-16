require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const isVercel = process.env.VERCEL === '1';
// const dbPath = path.join(__dirname, 'database.sqlite');
const bundledDbPath = path.join(__dirname, 'database.sqlite');
const dbPath = isVercel ? '/tmp/database.sqlite' : bundledDbPath;

// 1. Inisialisasi Groq Client
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
});

// 2. Konfigurasi Express & Session
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/logo', express.static(path.join(__dirname, 'logo')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'rahasia_tewiwi_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

// Gunakan /tmp saat di Vercel agar tidak error read-only filesystem
const upload = multer({ dest: isVercel ? '/tmp' : path.join(__dirname, 'uploads') });

// 3. Inisialisasi Database SQLite (sql.js)
let dbInstance = null;

async function getDb() {
    if (dbInstance) return dbInstance;

    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({
        locateFile: () => wasmPath
    });

    // Di Vercel, salin database bawaan ke /tmp agar bisa di-insert/update
    if (isVercel && !fs.existsSync(dbPath) && fs.existsSync(bundledDbPath)) {
        fs.copyFileSync(bundledDbPath, dbPath);
    }

    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        dbInstance = new SQL.Database(fileBuffer);
    } else {
        dbInstance = new SQL.Database();
    }

    dbInstance.run(`
        CREATE TABLE IF NOT EXISTS dokumen_pdf (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama_file TEXT NOT NULL,
            isi_teks TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    saveDb(dbInstance);
    return dbInstance;
}

function saveDb(db) {
    if (isVercel) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

// Middleware Proteksi Halaman Admin
function cekLoginAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/login');
}

// ==========================================
// ROUTE PENGUNJUNG (CHATBOT)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT nama_file FROM dokumen_pdf WHERE is_active = 1 LIMIT 1');
        let namaDokumen = 'Belum ada dokumen aktif';

        if (stmt.step()) {
            const row = stmt.getAsObject();
            namaDokumen = row.nama_file;
        }
        stmt.free();

        res.render('index', { namaDokumen });
    } catch (err) {
        console.error('SQLite Error (/):', err);
        res.status(500).send('Gagal memuat data dari database: ' + err.message);
    }
});

app.post('/api/chat', async (req, res) => {
    const { pesan } = req.body;
    if (!pesan) return res.status(400).json({ reply: 'Pesan tidak boleh kosong.' });

    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT nama_file, isi_teks FROM dokumen_pdf WHERE is_active = 1 LIMIT 1');
        let dokumen = null;

        if (stmt.step()) {
            dokumen = stmt.getAsObject();
        }
        stmt.free();

        if (!dokumen) {
            return res.json({ reply: 'Maaf, admin belum mengaktifkan dokumen PDF apapun sebagai referensi.' });
        }

        const konteksTeks = dokumen.isi_teks.substring(0, 18000);

        const completion = await groq.chat.completions.create({
            model: 'openai/gpt-oss-20b',
            messages: [
                {
                    role: 'system',
                    content: `Anda adalah asisten virtual Tewiwi Bakehouse. Jawab pertanyaan pengguna HANYA berdasarkan isi dokumen berikut (${dokumen.nama_file}). Jangan mengarang jawaban di luar dokumen. Jika informasi tidak ditemukan, katakan dengan sopan bahwa informasi tersebut tidak ada di dalam dokumen.\n\n--- ISI DOKUMEN ---\n${konteksTeks}\n\nJangan gunakan karakter lain selain numeric, tanda baca yang umum digunakan, dan alphabet.`
                },
                {
                    role: 'user',
                    content: pesan
                }
            ],
            temperature: 0.2,
            max_tokens: 1024
        });

        res.json({ reply: completion.choices[0].message.content });
    } catch (error) {
        console.error('Chat/Groq Error:', error);
        res.status(500).json({ reply: 'Gagal memproses jawaban dari AI. Coba beberapa saat lagi.' });
    }
});

// ==========================================
// ROUTE AUTENTIKASI ADMIN
// ==========================================
app.get('/login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }
    res.render('login', { error: 'Username atau password salah!' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==========================================
// ROUTE DASHBOARD ADMIN (KELOLA PDF)
// ==========================================
app.get('/admin', cekLoginAdmin, async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT id, nama_file, is_active, uploaded_at FROM dokumen_pdf ORDER BY uploaded_at DESC');
        const dokumenList = [];

        while (stmt.step()) {
            dokumenList.push(stmt.getAsObject());
        }
        stmt.free();

        res.render('admin', { dokumenList });
    } catch (err) {
        console.error('SQLite Error (/admin):', err);
        res.status(500).send('Gagal memuat daftar dokumen.');
    }
});

// Upload PDF Baru (Lazy-load pdf-parse agar tidak membebani cold start Vercel)
app.post('/admin/upload', cekLoginAdmin, upload.single('file_pdf'), async (req, res) => {
    if (!req.file) return res.send('File PDF wajib dipilih.');

    const filePath = req.file.path;
    const originalName = req.file.originalname;

    try {
        const PDFParser = require('pdf2json');
        const rawText = await new Promise((resolve, reject) => {
            const pdfParser = new PDFParser(null, 1);
            pdfParser.on('pdfParser_dataError', errData => reject(errData.parserError));
            pdfParser.on('pdfParser_dataReady', () => {
                resolve(pdfParser.getRawTextContent());
            });
            pdfParser.loadPDF(filePath);
        });

        const cleanText = rawText.replace(/\s+/g, ' ').trim();

        const db = await getDb();
        db.run('UPDATE dokumen_pdf SET is_active = 0');
        db.run(
            'INSERT INTO dokumen_pdf (nama_file, isi_teks, is_active) VALUES (?, ?, 1)',
            [originalName, cleanText]
        );
        saveDb(db);

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.redirect('/admin');
    } catch (error) {
        console.error('Error ekstraksi PDF:', error);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).send('Gagal memproses file PDF: ' + error.message);
    }
});

// Aktifkan Ulang Dokumen Lama
app.post('/admin/aktifkan/:id', cekLoginAdmin, async (req, res) => {
    const docId = Number(req.params.id);
    try {
        const db = await getDb();
        db.run('UPDATE dokumen_pdf SET is_active = 0');
        db.run('UPDATE dokumen_pdf SET is_active = 1 WHERE id = ?', [docId]);
        saveDb(db);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send('Gagal mengaktifkan dokumen.');
    }
});

// Hapus Dokumen
app.post('/admin/hapus/:id', cekLoginAdmin, async (req, res) => {
    const docId = Number(req.params.id);
    try {
        const db = await getDb();
        db.run('DELETE FROM dokumen_pdf WHERE id = ?', [docId]);
        saveDb(db);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send('Gagal menghapus dokumen.');
    }
});

if (!isVercel) {
    app.listen(PORT, () => {
        console.log(`Server aktif di http://localhost:${PORT}`);
    });
}

module.exports = app;