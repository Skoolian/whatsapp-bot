import "./system.js";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";
import P from "pino";
import fs from "fs";
import path from "path";
import { Boom } from "@hapi/boom";
import axios from "axios";
import FormData from "form-data";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";

const upload = multer({ dest: "temp_uploads/" });

const JWT_SECRET = "supersecret_whatsapp_bot_key";
const MASTER_PASSWORD = "123Abc##"; // Default password expected by backend
const BACKEND_URL = "https://skoolian.com"; // Updated to local loopback for safety, can be adjusted

// --- 1. DATABASE SETUP ---
const db = new Database("system.db");
db.exec(`
    CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, jid TEXT, status TEXT DEFAULT 'ACTIVE');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_phone ON admins (phone);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Seed master password
const row = db.prepare("SELECT value FROM settings WHERE key='password'").get();
if (!row) {
  const hash = bcrypt.hashSync(MASTER_PASSWORD, 10);
  db.prepare("INSERT INTO settings (key,value) VALUES ('password',?)").run(hash);
  console.log("🔑 Master password seeded into DB.");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.json());
app.use(express.static("public"));

let sock;
let qrCode = null;
let connectionStatus = "Disconnected";

// --- MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  // Allow using the secret itself as a static API key for backend sync
  if (token === JWT_SECRET) {
    req.user = { role: "admin" };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Forbidden" });
    req.user = user;
    next();
  });
};

const cleanPhone = (num) => {
  if (!num) return "";
  let cleaned = num.replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("0")) {
    cleaned = "88" + cleaned;
  }
  return cleaned;
};

io.on("connection", (socket) => {
  socket.emit("connection_status", {
    status: connectionStatus,
    phone: sock?.user?.id ? sock.user.id.split(":")[0] : null,
  });
  if (qrCode && connectionStatus !== "Connected") socket.emit("qr", qrCode);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
    },
    logger: P({ level: "silent" }),
    browser: ["Bidyaloy Bot", "Chrome", "1.0.0"],
    keepAliveIntervalMs: 10000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCode = qr;
      io.emit("qr", qr);
    }
    if (connection === "open") {
      connectionStatus = "Connected";
      qrCode = null;
      io.emit("connection_status", {
        status: "Connected",
        phone: sock.user.id.split(":")[0],
      });
      console.log("✅ SYSTEM ONLINE");
    }
    if (connection === "close") {
      const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderJid = jidNormalizedUser(msg.key.remoteJid);
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    console.log(`📩 Message received from: ${senderJid} | Content: ${text}`);

    // Add custom logic here for handling incoming messages if needed
  });
}

// --- API ---
app.get("/api/stats", (req, res) => {
  const activeAdmins = db.prepare("SELECT COUNT(*) as c FROM admins").get().c;
  res.json({ status: connectionStatus, activeAdmins });
});

app.get("/api/admins", (req, res) =>
  res.json(db.prepare("SELECT * FROM admins").all()),
);

app.post("/api/admins", authenticateToken, (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Missing fields" });
  const cleaned = cleanPhone(phone);

  const existing = db.prepare("SELECT id FROM admins WHERE phone = ?").get(cleaned);
  if (existing) return res.status(400).json({ error: "Phone number already exists" });

  db.prepare("INSERT INTO admins (name, phone, jid) VALUES (?, ?, ?)").run(
    name,
    cleaned,
    `${cleaned}@s.whatsapp.net`,
  );
  res.json({ success: true });
});

app.post("/api/sync-admins", authenticateToken, (req, res) => {
  const { admins } = req.body; // Expecting array of {name, phone}
  if (!Array.isArray(admins)) return res.status(400).json({ error: "Invalid data format" });

  const insert = db.prepare("INSERT OR IGNORE INTO admins (name, phone, jid) VALUES (?, ?, ?)");
  const transaction = db.transaction((data) => {
    for (const admin of data) {
      const cleaned = cleanPhone(admin.phone);
      insert.run(admin.name, cleaned, `${cleaned}@s.whatsapp.net`);
    }
  });

  try {
    transaction(admins);
    res.json({ success: true, count: admins.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admins/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM admins WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/whatsapp/logout", async (req, res) => {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) { }
  }
  fs.rmSync("./auth_session", { recursive: true, force: true });
  process.exit(0);
});

// Login with master password -> returns JWT
app.post("/login", (req, res) => {
  const { password } = req.body;
  const row = db.prepare("SELECT value FROM settings WHERE key='password'").get();
  if (!row) return res.status(500).json({ error: "Password not set" });

  if (!bcrypt.compareSync(password, row.value)) {
    return res.status(403).json({ error: "Wrong password" });
  }

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

// Send message
app.post("/send-message", authenticateToken, async (req, res) => {
  const { number, message } = req.body;
  try {
    if (!sock || connectionStatus !== "Connected") {
      return res.status(503).json({ error: "WhatsApp client not ready" });
    }
    const jid = `${cleanPhone(number)}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[API] Message sent to ${jid}`);
    res.json({ status: "success" });
  } catch (err) {
    console.error(`[API] Send error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3060;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bidyaloy Bot Server Live on port ${PORT}`);
  console.log(`🔗 Production: http://62.169.25.212:${PORT}`);
  startBot();
});
