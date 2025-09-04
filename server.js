// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 4001;

// --- enable CORS for frontend ---
app.use(cors());

// --- ensure uploads folder exists ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// --- multer setup (field name: "video") ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname;
    cb(null, unique);
  },
});
const upload = multer({ storage });

// --- connect to SQLite ---
const DB_FILE = path.join(__dirname, "database.db");
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error("❌ Failed to connect to SQLite:", err);
    process.exit(1);
  } else {
    console.log("✅ SQLite connected:", DB_FILE);
  }
});

// --- create table if not exists ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT NOT NULL,
      filepath   TEXT NOT NULL,
      filesize   INTEGER NOT NULL,
      mimetype   TEXT,
      createdAt  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// --- root route ---
app.get("/", (req, res) => {
  res.send("✅ Backend is running");
});

// --- health route ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
  });
});

// --- API: get all recordings ---
app.get("/api/recordings", (req, res) => {
  const sql = `SELECT id, filename, filepath, filesize, mimetype, createdAt
               FROM recordings
               ORDER BY datetime(createdAt) DESC`;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("❌ DB error:", err.message);
      return res.status(500).json({ error: "Failed to fetch recordings" });
    }
    res.json(rows);
  });
});

// --- API: upload a new recording ---
app.post("/api/recordings", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const { filename, path: filepath, size, mimetype } = req.file;

  const sql = `
    INSERT INTO recordings (filename, filepath, filesize, mimetype)
    VALUES (?, ?, ?, ?)
  `;

  db.run(sql, [filename, filepath, size, mimetype], function (err) {
    if (err) {
      console.error("❌ DB insert error:", err.message);
      return res.status(500).json({ error: "Failed to save recording" });
    }

    res.status(201).json({
      message: "✅ Recording uploaded successfully",
      recording: {
        id: this.lastID,
        filename,
        filepath,
        filesize: size,
        mimetype,
        createdAt: new Date().toISOString(),
      },
    });
  });
});

// --- API: stream a specific recording ---
app.get("/api/recordings/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT filename FROM recordings WHERE id = ?", [id], (err, row) => {
    if (err || !row) return res.status(404).send("Recording not found");

    const filePath = path.join(UPLOAD_DIR, row.filename);

    fs.stat(filePath, (err, stats) => {
      if (err) {
        return res.status(404).send("File not found");
      }

      let range = req.headers.range;
      if (!range) {
        // No range → send whole file
        res.writeHead(200, {
          "Content-Type": "video/webm",
          "Content-Length": stats.size,
        });
        fs.createReadStream(filePath).pipe(res);
      } else {
        // Partial request (streaming)
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/webm",
        });

        fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    });
  });
});


// --- start server ---
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
