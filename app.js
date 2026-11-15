require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Inisialisasi Groq Client
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
});

// 2. Konfigurasi Express & Session
app.set('view engine', 'ejs');
app.use('/logo', express.static('logo'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'rahasia_tewiwi_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // Sesi aktif 1 jam
}));

// Konfigurasi Upload Sementara
const upload = multer({ dest: 'uploads/' });

// 3. Inisialisasi Database SQLite (Otomatis membuat file database.sqlite)
const db = new Database(path.join(__dirname, 'database.sqlite'));

// Buat tabel otomatis jika belum ada
db.exec(`
    CREATE TABLE IF NOT EXISTS dokumen_pdf (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama_file TEXT NOT NULL,
        isi_teks TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

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
app.get('/', (req, res) => {
    try {
        const dokumen = db.prepare('SELECT nama_file FROM dokumen_pdf WHERE is_active = 1 LIMIT 1').get();
        const namaDokumen = dokumen ? dokumen.nama_file : 'Belum ada dokumen aktif';
        res.render('index', { namaDokumen });
    } catch (err) {
        console.error('SQLite Error (/):', err.message);
        res.status(500).send('Gagal memuat data dari database.');
    }
});

app.post('/api/chat', async (req, res) => {
    const { pesan } = req.body;
    if (!pesan) return res.status(400).json({ reply: 'Pesan tidak boleh kosong.' });

    try {
        const dokumen = db.prepare('SELECT nama_file, isi_teks FROM dokumen_pdf WHERE is_active = 1 LIMIT 1').get();

        if (!dokumen) {
            return res.json({ reply: 'Maaf, admin belum mengaktifkan dokumen PDF apapun sebagai referensi.' });
        }

        // Ambil maksimal 18.000 karakter pertama agar aman dari batas TPM Groq
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
app.get('/admin', cekLoginAdmin, (req, res) => {
    try {
        const dokumenList = db.prepare('SELECT id, nama_file, is_active, uploaded_at FROM dokumen_pdf ORDER BY uploaded_at DESC').all();
        res.render('admin', { dokumenList });
    } catch (err) {
        console.error('SQLite Error (/admin):', err.message);
        res.status(500).send('Gagal memuat daftar dokumen.');
    }
});

// Upload PDF Baru
app.post('/admin/upload', cekLoginAdmin, upload.single('file_pdf'), async (req, res) => {
    if (!req.file) return res.send('File PDF wajib dipilih.');

    const filePath = req.file.path;
    const originalName = req.file.originalname;

    try {
        const dataBuffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();
        await parser.destroy();
        const cleanText = pdfData.text.replace(/\s+/g, ' ').trim();

        // Nonaktifkan dokumen lama & simpan dokumen baru dalam satu transaksi
        const simpanDokumen = db.transaction(() => {
            db.prepare('UPDATE dokumen_pdf SET is_active = 0').run();
            db.prepare('INSERT INTO dokumen_pdf (nama_file, isi_teks, is_active) VALUES (?, ?, 1)').run(originalName, cleanText);
        });
        simpanDokumen();

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.redirect('/admin');
    } catch (error) {
        console.error('Error ekstraksi PDF:', error);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).send('Gagal memproses file PDF.');
    }
});

// Aktifkan Ulang Dokumen Lama
app.post('/admin/aktifkan/:id', cekLoginAdmin, (req, res) => {
    const docId = req.params.id;
    try {
        const aktifkan = db.transaction(() => {
            db.prepare('UPDATE dokumen_pdf SET is_active = 0').run();
            db.prepare('UPDATE dokumen_pdf SET is_active = 1 WHERE id = ?').run(docId);
        });
        aktifkan();
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send('Gagal mengaktifkan dokumen.');
    }
});

// Hapus Dokumen
app.post('/admin/hapus/:id', cekLoginAdmin, (req, res) => {
    const docId = req.params.id;
    try {
        db.prepare('DELETE FROM dokumen_pdf WHERE id = ?').run(docId);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send('Gagal menghapus dokumen.');
    }
});

app.listen(PORT, () => {
    console.log(`Server aktif di port ${PORT}`);
});