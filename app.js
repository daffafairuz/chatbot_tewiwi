require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
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

// 3. Koneksi Database MySQL / TiDB Cloud (Menggunakan Pool + Port + SSL)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10
});

// Middleware untuk melindungi route Admin
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
    const query = 'SELECT nama_file FROM dokumen_pdf WHERE is_active = TRUE LIMIT 1';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Database Error (/):', err.message);
            return res.status(500).send('Gagal terhubung ke database.');
        }
        const namaDokumen = results.length > 0 ? results[0].nama_file : 'Belum ada dokumen aktif';
        res.render('index', { namaDokumen });
    });
});

app.post('/api/chat', (req, res) => {
    const { pesan } = req.body;
    if (!pesan) return res.status(400).json({ reply: 'Pesan tidak boleh kosong.' });

    const query = 'SELECT nama_file, isi_teks FROM dokumen_pdf WHERE is_active = TRUE LIMIT 1';
    db.query(query, async (err, results) => {
        if (err) {
            console.error('Database Error (/api/chat):', err.message);
            return res.status(500).json({ reply: 'Kesalahan pada database.' });
        }
        if (results.length === 0) {
            return res.json({ reply: 'Maaf, admin belum mengaktifkan dokumen PDF apapun sebagai referensi.' });
        }

        const dokumen = results[0];
        // Ambil maksimal 18.000 karakter pertama agar aman dari batas TPM Groq
        const konteksTeks = dokumen.isi_teks.substring(0, 18000);

        try {
            const completion = await groq.chat.completions.create({
                model: 'openai/gpt-oss-20b',
                messages: [
                    {
                        role: 'system',
                        content: `Anda adalah asisten virtual. Jawab pertanyaan pengguna HANYA berdasarkan isi dokumen berikut (${dokumen.nama_file}). Jangan mengarang jawaban di luar dokumen. Jika informasi tidak ditemukan, katakan dengan sopan bahwa informasi tersebut tidak ada di dalam dokumen.\n\n--- ISI DOKUMEN ---\n${konteksTeks}\n\nJangan gunakan karakter lain selain numeric, tanda baca yang umum digunakan, dan alphabet.`
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
            console.error('Groq Error:', error);
            res.status(500).json({ reply: 'Gagal memproses jawaban dari AI. Coba beberapa saat lagi.' });
        }
    });
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
    const query = 'SELECT id, nama_file, is_active, uploaded_at FROM dokumen_pdf ORDER BY uploaded_at DESC';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Database Error (/admin):', err.message);
            return res.status(500).send('Gagal memuat daftar dokumen.');
        }
        res.render('admin', { dokumenList: results });
    });
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

        // Nonaktifkan semua dokumen lama
        db.query('UPDATE dokumen_pdf SET is_active = FALSE', (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Gagal memperbarui status dokumen.');
            }

            // Simpan dokumen baru sebagai aktif
            const sql = 'INSERT INTO dokumen_pdf (nama_file, isi_teks, is_active) VALUES (?, ?, TRUE)';
            db.query(sql, [originalName, cleanText], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Gagal menyimpan dokumen ke database.');
                }
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                res.redirect('/admin');
            });
        });
    } catch (error) {
        console.error('Error ekstraksi PDF:', error);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).send('Gagal memproses file PDF.');
    }
});

// Aktifkan Ulang Dokumen Lama
app.post('/admin/aktifkan/:id', cekLoginAdmin, (req, res) => {
    const docId = req.params.id;
    db.query('UPDATE dokumen_pdf SET is_active = FALSE', (err) => {
        if (err) return res.status(500).send('Gagal memproses.');
        db.query('UPDATE dokumen_pdf SET is_active = TRUE WHERE id = ?', [docId], (err) => {
            if (err) return res.status(500).send('Gagal mengaktifkan dokumen.');
            res.redirect('/admin');
        });
    });
});

// Hapus Dokumen
app.post('/admin/hapus/:id', cekLoginAdmin, (req, res) => {
    const docId = req.params.id;
    db.query('DELETE FROM dokumen_pdf WHERE id = ?', [docId], (err) => {
        if (err) return res.status(500).send('Gagal menghapus dokumen.');
        res.redirect('/admin');
    });
});

app.listen(PORT, () => {
    console.log(`Server aktif di port ${PORT}`);
});