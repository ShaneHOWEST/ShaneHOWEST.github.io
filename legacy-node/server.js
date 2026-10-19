import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import Parser from "rss-parser";
import Stripe from "stripe";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "nieuwsai.sqlite");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
const parser = new Parser({ timeout: 10000 });
const sessions = new Map();
const app = express();
let syncInProgress = false;

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    stripe_customer_id TEXT,
    email_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'rss',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT,
    provider TEXT,
    timestamp TEXT NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'monthly',
    current_period_end TEXT,
    source_share_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscription_shares (
    id TEXT PRIMARY KEY,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    invited_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_user_id, email)
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS daily_visitors (
    visit_date TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (visit_date, visitor_id)
  );
`);
for (const statement of [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
  "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT",
  "ALTER TABLE articles ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
  "ALTER TABLE subscriptions ADD COLUMN source_share_id TEXT",
  "ALTER TABLE sources ADD COLUMN type TEXT NOT NULL DEFAULT 'rss'",
]) {
  try { db.exec(statement); } catch (error) { if (!String(error.message).includes("duplicate column")) throw error; }
}
db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at)").run();
db.prepare("UPDATE subscriptions SET source_share_id = (SELECT id FROM subscription_shares WHERE invited_user_id = subscriptions.user_id AND status = 'accepted' LIMIT 1) WHERE plan = 'shared' AND source_share_id IS NULL").run();
db.prepare("UPDATE articles SET is_premium = 1 WHERE is_premium != 1").run();

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function getSetting(key, fallback = "") {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value ?? fallback;
}
function saveSetting(key, value) {
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(key, value);
}
for (const [key, value] of Object.entries({
  stripe_secret_key: process.env.STRIPE_SECRET_KEY || "",
  stripe_price_id: process.env.STRIPE_PRICE_ID || "",
  stripe_webhook_secret: process.env.STRIPE_WEBHOOK_SECRET || "",
  smtp_host: process.env.SMTP_HOST || "",
  smtp_port: process.env.SMTP_PORT || "587",
  smtp_secure: process.env.SMTP_SECURE || "false",
  smtp_user: process.env.SMTP_USER || "",
  smtp_password: process.env.SMTP_PASSWORD || "",
  smtp_from: process.env.SMTP_FROM || "",
})) {
  if (!db.prepare("SELECT key FROM app_settings WHERE key = ?").get(key)) saveSetting(key, value);
}
function getStripe() {
  const secret = getSetting("stripe_secret_key");
  return secret ? new Stripe(secret) : null;
}
function getMailer() {
  const host = getSetting("smtp_host");
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(getSetting("smtp_port", "587") || 587),
    secure: getSetting("smtp_secure") === "true",
    auth: getSetting("smtp_user") ? { user: getSetting("smtp_user"), pass: getSetting("smtp_password") } : undefined,
  });
}
function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function staffRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== "staff") return res.status(403).json({ error: "Alleen staff-accounts hebben toegang tot het beheerpaneel." });
    next();
  });
}
function hasActiveSubscription(userId) {
  return Boolean(db.prepare(`
    SELECT subscriptions.id
    FROM subscriptions
    LEFT JOIN subscription_shares ON subscription_shares.id = subscriptions.source_share_id
    LEFT JOIN subscriptions owner_subscription ON subscription_shares.status = 'accepted'
      AND owner_subscription.user_id = subscription_shares.owner_user_id
      AND owner_subscription.plan != 'shared'
      AND owner_subscription.status IN ('active', 'trialing')
      AND (owner_subscription.current_period_end IS NULL OR owner_subscription.current_period_end > datetime('now'))
    WHERE subscriptions.user_id = ?
      AND subscriptions.status IN ('active', 'trialing')
      AND (subscriptions.plan = 'shared' OR subscriptions.current_period_end IS NULL OR subscriptions.current_period_end > datetime('now'))
      AND (subscriptions.plan != 'shared' OR owner_subscription.id IS NOT NULL)
  `).get(userId));
}
function hasOwnActiveSubscription(userId) {
  return Boolean(db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND plan != 'shared' AND status IN ('active', 'trialing') AND (current_period_end IS NULL OR current_period_end > datetime('now'))").get(userId));
}
function hasSharedActiveSubscription(userId) {
  return Boolean(db.prepare(`
    SELECT subscriptions.id
    FROM subscriptions
    JOIN subscription_shares ON subscription_shares.id = subscriptions.source_share_id AND subscription_shares.status = 'accepted'
    WHERE subscriptions.user_id = ? AND subscriptions.plan = 'shared'
      AND subscriptions.status IN ('active', 'trialing')
      AND (subscriptions.plan = 'shared' OR subscriptions.current_period_end IS NULL OR subscriptions.current_period_end > datetime('now'))
      AND EXISTS (
        SELECT 1 FROM subscriptions owner_subscription
        WHERE owner_subscription.user_id = subscription_shares.owner_user_id
          AND owner_subscription.plan != 'shared'
          AND owner_subscription.status IN ('active', 'trialing')
          AND (owner_subscription.current_period_end IS NULL OR owner_subscription.current_period_end > datetime('now'))
      )
  `).get(userId));
}
function deactivateSharedAccess(userId) {
  db.prepare("UPDATE subscription_shares SET status = 'converted' WHERE invited_user_id = ? AND status = 'accepted'").run(userId);
  db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE user_id = ? AND plan = 'shared' AND status IN ('active', 'trialing')").run(userId);
}
function subscriberRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== "staff" && !hasActiveSubscription(req.user.id)) return res.status(402).json({ error: "Een actief abonnement is vereist." });
    next();
  });
}
function passwordMatches(password, stored) {
  if (stored.startsWith("scrypt$")) {
    const [, salt, digest] = stored.split("$");
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), crypto.scryptSync(password, salt, 64));
  }
  return hash(password) === stored;
}
function seedDatabase() {
  const email = process.env.ADMIN_EMAIL || "admin@nieuwsai.local";
  const password = process.env.ADMIN_PASSWORD || "change-me-now";
  if (!db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'staff')").run(email, hash(password));
  }
  db.prepare("UPDATE users SET role = 'staff' WHERE email = ?").run(email);
  const legacyFile = path.join(DATA_DIR, "config.json");
  if (fs.existsSync(legacyFile)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      const sourceCount = db.prepare("SELECT COUNT(*) AS count FROM sources").get().count;
      if (sourceCount === 0 && legacy.sources?.length) {
        const insert = db.prepare("INSERT OR IGNORE INTO sources (id, name, url, enabled) VALUES (?, ?, ?, ?)");
        for (const source of legacy.sources) insert.run(source.id || crypto.randomUUID(), source.name, source.url, source.enabled === false ? 0 : 1);
      }
      const providerInsert = db.prepare("INSERT OR IGNORE INTO providers (id, name, type, url, model, api_key, enabled, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const provider of legacy.providers || []) providerInsert.run(provider.id || crypto.randomUUID(), provider.name, provider.type || "openai", provider.url, provider.model, provider.apiKey, provider.enabled === false ? 0 : 1, provider.priority || 1);
      const articleInsert = db.prepare("INSERT OR IGNORE INTO articles (id, title, excerpt, body, category, source, url, provider, timestamp, is_premium) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const article of legacy.articles || []) articleInsert.run(article.id || crypto.randomUUID(), article.title, article.excerpt || article.summary || "", article.body || "", article.category || "Nieuws", article.source || "Onbekende bron", article.url || "", article.provider || "", article.timestamp || new Date().toISOString(), article.is_premium === false ? 0 : 1);
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
    } catch (error) { console.warn(`Legacy-configuratie kon niet worden gemigreerd: ${error.message}`); }
  }
}
seedDatabase();

function providerSafe(provider) {
  return { id: provider.id, name: provider.name, type: provider.type, url: provider.url, model: provider.model, enabled: Boolean(provider.enabled), priority: provider.priority, apiKey: provider.api_key ? "••••••••" : "" };
}
function sessionToken(req) { return req.headers.cookie?.match(/nieuwsai_session=([^;]+)/)?.[1]; }
function visitorId(req, res) {
  const existing = req.headers.cookie?.match(/nieuwsflits_visitor=([^;]+)/)?.[1];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const created = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `nieuwsflits_visitor=${created}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
  return created;
}
function recordVisitor(req, res) {
  const id = visitorId(req, res);
  db.prepare("INSERT OR IGNORE INTO daily_visitors (visit_date, visitor_id) VALUES (date('now'), ?)").run(id);
}
function homepageStats() {
  return {
    totalArticles: db.prepare("SELECT COUNT(*) AS count FROM articles").get().count,
    newArticlesToday: db.prepare("SELECT COUNT(*) AS count FROM articles WHERE date(timestamp) = date('now')").get().count,
    readersToday: db.prepare("SELECT COUNT(*) AS count FROM daily_visitors WHERE visit_date = date('now')").get().count,
  };
}
function authRequired(req, res, next) {
  const token = sessionToken(req);
  const session = token && db.prepare("SELECT users.id, users.email, users.role, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?").get(token ? hash(token) : "");
  if (!session || session.expires_at < Date.now()) return res.status(401).json({ error: "Authenticatie vereist." });
  req.user = session;
  next();
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash(token), userId, Date.now() + 8 * 60 * 60 * 1000);
  return token;
}
function allProviders() { return db.prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY priority ASC").all(); }
async function sendMail(to, subject, text) {
  const mailer = getMailer();
  if (!mailer) {
    console.log(`[mail-preview] To: ${to} | ${subject} | ${text}`);
    return;
  }
  await mailer.sendMail({ from: getSetting("smtp_from", "NieuwsFlits <no-reply@nieuwsai.local>"), to, subject, text });
}
function verificationUrl(token) {
  return `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/?verify=${encodeURIComponent(token)}`;
}
async function sendVerificationMail(user, token) {
  await sendMail(user.email, "Bevestig je NieuwsFlits-account", `Welkom bij NieuwsFlits.\n\nBevestig je e-mailadres via deze link:\n${verificationUrl(token)}\n\nDeze link is 24 uur geldig.`);
}
function createVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
  db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash(token), userId, Date.now() + 24 * 60 * 60 * 1000);
  return token;
}
function isEmailVerified(userId) {
  return Boolean(db.prepare("SELECT email_verified_at FROM users WHERE id = ? AND email_verified_at IS NOT NULL").get(userId));
}
function activatePendingShare(userId, email) {
  const invite = db.prepare("SELECT id FROM subscription_shares WHERE email = ? AND status = 'pending' LIMIT 1").get(email);
  if (!invite) return false;
  db.prepare("UPDATE subscription_shares SET invited_user_id = ?, status = 'accepted' WHERE id = ?").run(userId, invite.id);
  db.prepare("INSERT INTO subscriptions (id, user_id, status, plan, current_period_end, source_share_id) VALUES (?, ?, 'active', 'shared', datetime('now', '+30 days'), ?)").run(crypto.randomUUID(), userId, invite.id);
  return true;
}
function publicArticle(article, user) {
  const premium = Boolean(article.is_premium);
  const allowed = !premium || user?.role === "staff" || (user && hasActiveSubscription(user.id));
  const body = String(article.body || "");
  const previewLength = Math.max(1, Math.ceil(body.length * 0.4));
  return { ...article, body: allowed ? body : `${body.slice(0, previewLength)}…`, locked: !allowed, previewPercent: allowed ? 100 : 40 };
}

async function callProvider(provider, prompt) {
  const headers = { "Content-Type": "application/json" };
  let body;
  let endpoint = provider.url;
  if (provider.type === "gemini") {
    endpoint = endpoint.replace("{model}", encodeURIComponent(provider.model));
    const url = new URL(endpoint);
    if (!url.searchParams.has("key")) url.searchParams.set("key", provider.api_key);
    endpoint = url.toString();
    body = {
      systemInstruction: { parts: [{ text: "Je bent een zorgvuldige Nederlandstalige nieuwsredacteur. Geef uitsluitend JSON terug met title, summary, body, source en category." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 3000, responseMimeType: "application/json" },
    };
  } else if (provider.type === "anthropic") {
    headers["x-api-key"] = provider.api_key;
    headers["anthropic-version"] = "2023-06-01";
    body = { model: provider.model, max_tokens: 3000, system: "Je bent een zorgvuldige Nederlandstalige nieuwsredacteur. Geef uitsluitend JSON terug met title, summary, body, source en category.", messages: [{ role: "user", content: prompt }] };
  } else {
    headers.Authorization = `Bearer ${provider.api_key}`;
    body = { model: provider.model, temperature: 0.3, max_tokens: 3000, messages: [{ role: "system", content: "Je bent een zorgvuldige Nederlandstalige nieuwsredacteur. Geef uitsluitend JSON terug met title, summary, body, source en category." }, { role: "user", content: prompt }] };
  }
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${provider.name}: HTTP ${response.status}`);
  const payload = await response.json();
  const content = provider.type === "gemini"
    ? payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
    : provider.type === "anthropic" ? payload.content?.[0]?.text : payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider.name}: leeg antwoord`);
  return JSON.parse(String(content).replace(/^```json|```$/g, "").trim());
}

app.use(express.static(__dirname));
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = getStripe();
  const webhookSecret = getSetting("stripe_webhook_secret");
  if (!stripe || !webhookSecret) return res.status(503).send("Stripe is niet geconfigureerd.");
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret); }
  catch { return res.status(400).send("Ongeldige Stripe-signature."); }
  if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId || subscription.client_reference_id;
    const stripeSubscriptionId = subscription.subscription || subscription.id;
    if (userId && stripeSubscriptionId) {
      const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
      deactivateSharedAccess(Number(userId));
      db.prepare("INSERT INTO subscriptions (id, user_id, stripe_subscription_id, status, plan, current_period_end) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(stripe_subscription_id) DO UPDATE SET status=excluded.status, current_period_end=excluded.current_period_end").run(crypto.randomUUID(), Number(userId), stripeSubscriptionId, subscription.status || "active", "monthly", currentPeriodEnd);
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const ownerSubscription = db.prepare("SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?").get(event.data.object.id);
    db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = ?").run(event.data.object.id);
    if (ownerSubscription) {
      db.prepare("UPDATE subscription_shares SET status = 'revoked' WHERE owner_user_id = ? AND status IN ('pending', 'accepted')").run(ownerSubscription.user_id);
      db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE source_share_id IN (SELECT id FROM subscription_shares WHERE owner_user_id = ?) AND plan = 'shared'").run(ownerSubscription.user_id);
    }
  }
  res.json({ received: true });
});
app.use(express.json({ limit: "1mb" }));
app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
  if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: "Onjuiste inloggegevens." });
  if (!isEmailVerified(user.id)) return res.status(403).json({ error: "Bevestig eerst je e-mailadres via de link in je verificatiemail." });
  activatePendingShare(user.id, email);
  const token = createSession(user.id);
  res.setHeader("Set-Cookie", `nieuwsai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ id: user.id, email: user.email, role: user.role, subscribed: hasActiveSubscription(user.id) });
});
app.post("/api/auth/logout", (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  res.setHeader("Set-Cookie", "nieuwsai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.post("/api/auth/signup", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
  if (password.length < 10) return res.status(400).json({ error: "Gebruik een wachtwoord van minimaal 10 tekens." });
  try {
    const result = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'member')").run(email, passwordHash(password));
    const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(result.lastInsertRowid);
    const verificationToken = createVerificationToken(user.id);
    sendVerificationMail(user, verificationToken).catch((error) => console.error("[mail] verificatiemail mislukt:", error.message));
    res.status(201).json({ id: Number(result.lastInsertRowid), email, role: "member", subscribed: false, verificationRequired: true });
  } catch (error) { console.error("[auth] signup mislukt:", error.message); res.status(409).json({ error: "Er bestaat al een account met dit e-mailadres." }); }
});
app.post("/api/auth/verify", (req, res) => {
  const token = String(req.body.token || "");
  const record = token ? db.prepare("SELECT user_id FROM email_verification_tokens WHERE token_hash = ? AND expires_at > ?").get(hash(token), Date.now()) : null;
  if (!record) return res.status(400).json({ error: "Deze verificatielink is ongeldig of verlopen." });
  const user = db.prepare("SELECT id, email, role FROM users WHERE id = ?").get(record.user_id);
  db.prepare("UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?").run(record.user_id);
  db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(record.user_id);
  const subscribed = activatePendingShare(user.id, user.email);
  const session = createSession(user.id);
  res.setHeader("Set-Cookie", `nieuwsai_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ id: user.id, email: user.email, role: user.role, subscribed: subscribed || hasActiveSubscription(user.id) });
});
app.post("/api/auth/resend-verification", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
  if (!user || isEmailVerified(user.id)) return res.json({ ok: true });
  const token = createVerificationToken(user.id);
  await sendVerificationMail(user, token);
  res.json({ ok: true });
});
app.get("/api/auth/me", authRequired, (req, res) => res.json({ id: req.user.id, email: req.user.email, role: req.user.role, subscribed: hasActiveSubscription(req.user.id) }));
app.get("/api/account", authRequired, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.user.id);
  const subscription = db.prepare("SELECT status, plan, current_period_end FROM subscriptions WHERE user_id = ? ORDER BY CASE WHEN plan = 'shared' THEN 1 ELSE 0 END, created_at DESC LIMIT 1").get(req.user.id) || null;
  const shares = db.prepare("SELECT id, email, status, created_at FROM subscription_shares WHERE owner_user_id = ? ORDER BY created_at").all(req.user.id);
  res.json({ user, subscription, shares, subscribed: hasActiveSubscription(req.user.id), ownSubscribed: hasOwnActiveSubscription(req.user.id), sharedSubscribed: hasSharedActiveSubscription(req.user.id) });
});
app.patch("/api/account", authRequired, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
  try {
    const current = db.prepare("SELECT id, email FROM users WHERE id = ?").get(req.user.id);
    if (current.email === email) return res.json({ email, verificationRequired: false });
    db.prepare("UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?").run(email, req.user.id);
    const user = { id: req.user.id, email };
    const token = createVerificationToken(req.user.id);
    sendVerificationMail(user, token).catch((error) => console.error("[mail] verificatiemail mislukt:", error.message));
    res.json({ email, verificationRequired: true });
  } catch { res.status(409).json({ error: "Dit e-mailadres is al in gebruik." }); }
});
app.get("/api/admin/config", staffRequired, (req, res) => {
  const sources = db.prepare("SELECT id, name, url, type, enabled FROM sources ORDER BY created_at").all();
  const providers = db.prepare("SELECT * FROM providers ORDER BY priority").all().map(providerSafe);
  res.json({
    sources,
    providers,
    integrations: {
      stripeSecretKey: getSetting("stripe_secret_key") ? "••••••••" : "",
      stripePriceId: getSetting("stripe_price_id"),
      stripeWebhookSecret: getSetting("stripe_webhook_secret") ? "••••••••" : "",
      smtpHost: getSetting("smtp_host"),
      smtpPort: getSetting("smtp_port", "587"),
      smtpSecure: getSetting("smtp_secure", "false"),
      smtpUser: getSetting("smtp_user"),
      smtpPassword: getSetting("smtp_password") ? "••••••••" : "",
      smtpFrom: getSetting("smtp_from"),
    },
  });
});
app.put("/api/admin/integrations", staffRequired, (req, res) => {
  const input = req.body || {};
  const fields = {
    stripe_secret_key: input.stripeSecretKey,
    stripe_price_id: input.stripePriceId,
    stripe_webhook_secret: input.stripeWebhookSecret,
    smtp_host: input.smtpHost,
    smtp_port: input.smtpPort,
    smtp_secure: input.smtpSecure,
    smtp_user: input.smtpUser,
    smtp_password: input.smtpPassword,
    smtp_from: input.smtpFrom,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "" && !String(value).startsWith("••")) saveSetting(key, String(value).trim());
  }
  res.json({ ok: true });
});
app.get("/api/admin/users", staffRequired, (req, res) => {
  const users = db.prepare("SELECT id, email, role, created_at FROM users ORDER BY created_at").all();
  res.json({ users });
});
app.post("/api/admin/users", staffRequired, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
  if (password.length < 10) return res.status(400).json({ error: "Gebruik een wachtwoord van minimaal 10 tekens." });
  try {
    const result = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)").run(email, passwordHash(password), req.body.role === "staff" ? "staff" : "member");
    const user = { id: Number(result.lastInsertRowid), email };
    const verificationToken = createVerificationToken(user.id);
    sendVerificationMail(user, verificationToken).catch((error) => console.error("[mail] verificatiemail voor nieuwe gebruiker mislukt:", error.message));
    res.status(201).json({ ...user, verificationRequired: true });
  } catch {
    res.status(409).json({ error: "Er bestaat al een gebruiker met dit e-mailadres." });
  }
});
app.delete("/api/admin/users/:id", staffRequired, (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (userCount <= 1) return res.status(400).json({ error: "De laatste gebruiker kan niet worden verwijderd." });
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  const current = db.prepare("SELECT id FROM users WHERE email = ?").get(req.user.email);
  if (!target) return res.status(404).json({ error: "Gebruiker niet gevonden." });
  if (target.id === current.id) return res.status(400).json({ error: "Je kunt je eigen gebruiker niet verwijderen." });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/admin/sources", staffRequired, (req, res) => {
  const name = String(req.body.name || "").trim();
  const url = String(req.body.url || "").trim();
  const type = req.body.type === "website" ? "website" : "rss";
  if (!name || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Naam en geldige URL zijn vereist." });
  const source = { id: crypto.randomUUID(), name, url, type };
  try { db.prepare("INSERT INTO sources (id, name, url, type) VALUES (?, ?, ?, ?)").run(source.id, source.name, source.url, source.type); res.status(201).json(source); }
  catch { res.status(409).json({ error: "Deze nieuwsbron bestaat al." }); }
});
app.delete("/api/admin/sources/:id", staffRequired, (req, res) => { db.prepare("DELETE FROM sources WHERE id = ?").run(req.params.id); res.json({ ok: true }); });
app.post("/api/admin/providers", staffRequired, (req, res) => {
  const input = req.body;
  if (!input.name || !input.type || !input.url || !input.model || !input.apiKey) return res.status(400).json({ error: "Provider, endpoint, model en API-key zijn vereist." });
  const id = input.id || crypto.randomUUID();
  db.prepare("INSERT INTO providers (id, name, type, url, model, api_key, enabled, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, url=excluded.url, model=excluded.model, api_key=excluded.api_key, enabled=excluded.enabled, priority=excluded.priority").run(id, input.name, input.type, input.url, input.model, input.apiKey, input.enabled === false ? 0 : 1, Number(input.priority || 1));
  res.status(201).json(providerSafe(db.prepare("SELECT * FROM providers WHERE id = ?").get(id)));
});
app.delete("/api/admin/providers/:id", staffRequired, (req, res) => {
  const result = db.prepare("DELETE FROM providers WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "AI-provider niet gevonden." });
  res.json({ ok: true });
});
async function rewriteWithFallback(prompt) {
  for (const provider of allProviders()) {
    try {
      const article = await callProvider(provider, prompt);
      if (!article.title || !article.body || String(article.body).trim().length < 300) {
        throw new Error(`${provider.name}: onvolledig artikelantwoord`);
      }
      return { article, provider };
    }
    catch (error) { console.warn(error.message); }
  }
  return null;
}
function saveArticle(article, source, provider, originalUrl) {
  const existing = db.prepare("SELECT id FROM articles WHERE url = ?").get(originalUrl || source.url);
  if (existing) return null;
  const record = { id: crypto.randomUUID(), title: article.title, excerpt: article.summary || "", body: article.body || "", category: article.category || "Nieuws", source: article.source || source.name, url: originalUrl || source.url, provider: provider.name, timestamp: new Date().toISOString(), is_premium: 1 };
  db.prepare("INSERT INTO articles (id, title, excerpt, body, category, source, url, provider, timestamp, is_premium) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, record.title, record.excerpt, record.body, record.category, record.source, record.url, record.provider, record.timestamp, record.is_premium);
  return record;
}
function stripMarkup(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/\s+/g, " ")
    .trim();
}
function extractPageArticle(html) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const candidates = [];
  for (const match of cleaned.matchAll(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/gi)) candidates.push(match[2]);
  const selected = candidates.sort((a, b) => b.length - a.length)[0] || cleaned;
  const paragraphs = [...selected.matchAll(/<(p|h[1-6]|blockquote|li)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => stripMarkup(match[2]))
    .filter((text) => text.length >= 35);
  return paragraphs.length >= 3 ? paragraphs.join("\n\n") : stripMarkup(selected);
}
async function fetchHtml(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "NieuwsFlits/1.0 (+news importer)" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
function extractWebsiteLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = stripMarkup(match[2]);
    if (label.length < 25) continue;
    let url;
    try { url = new URL(match[1], base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname !== base.hostname) continue;
    if (url.pathname === base.pathname || /\.(jpg|jpeg|png|gif|webp|pdf|xml|rss)$/i.test(url.pathname)) continue;
    if (/\/(contact|over-ons|privacy|cookie|zoeken|search|login|account|video|tag|tags|auteurs?)\b/i.test(url.pathname)) continue;
    url.hash = "";
    const key = url.toString();
    if (!links.some((item) => item.url === key)) links.push({ url: key, label });
  }
  return links.slice(0, 8);
}
async function websiteItems(source) {
  const html = await fetchHtml(source.url);
  return extractWebsiteLinks(html, source.url).map((item) => ({
    title: item.label,
    link: item.url,
    content: "",
  }));
}
function feedItemBody(item) {
  return stripMarkup(
    item["content:encoded"]
    || item.content
    || item["content:encodedSnippet"]
    || item.description
    || item.summary
    || item.contentSnippet,
  );
}
async function fetchFullArticleBody(url) {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "NieuwsFlits/1.0 article importer" } });
    if (!response.ok) return "";
    const html = await response.text();
    const text = extractPageArticle(html);
    return text.length > 500 ? text : "";
  } catch (error) {
    console.warn(`Volledig artikel kon niet worden opgehaald (${url}): ${error.message}`);
    return "";
  }
}
async function syncNews() {
  if (syncInProgress) return { imported: 0, skipped: true, reason: "already_running", articles: [] };
  if (!allProviders().length) return { imported: 0, skipped: true, reason: "no_provider", articles: [] };
  syncInProgress = true;
  const imported = [];
  const stats = { discovered: 0, duplicates: 0, missingText: 0, providerFailures: 0, sourceFailures: 0 };
  try {
    for (const source of db.prepare("SELECT * FROM sources WHERE enabled = 1").all()) {
      try {
        const items = source.type === "website"
          ? await websiteItems(source)
          : (await parser.parseURL(source.url)).items || [];
        for (const item of items.slice(0, 5)) {
          stats.discovered += 1;
          const originalUrl = item.link || item.guid || source.url;
          const feedBody = source.type === "website" ? "" : feedItemBody(item);
          const fullBody = feedBody.length >= 1800 ? feedBody : await fetchFullArticleBody(originalUrl);
          const articleBody = fullBody || feedBody;
          if (articleBody.length < 300) {
            stats.missingText += 1;
            console.warn(`RSS ${source.name}: volledige artikeltekst ontbreekt voor ${originalUrl}`);
            continue;
          }
          const result = await rewriteWithFallback(`Herschrijf het VOLLEDIGE nieuwsartikel hieronder in helder Nederlands. Gebruik alle aangeleverde broninhoud, niet alleen titel, samenvatting of eerste alinea. Behoud alle belangrijke feiten, namen, cijfers, citaten, volgorde en context; verzin niets. Schrijf een zelfstandige volledige artikelbody van minimaal 6 inhoudelijke alinea's (of alle broninformatie als de bron korter is), plus een korte summary. Geef uitsluitend JSON terug met title, summary, body, source en category. Oorspronkelijke titel: ${item.title || ""}\nVolledige brontekst:\n${articleBody}\nBron: ${source.name} (${originalUrl})`);
          if (!result) {
            stats.providerFailures += 1;
            continue;
          }
          const saved = saveArticle(result.article, source, result.provider, originalUrl);
          if (saved) imported.push(saved);
          else stats.duplicates += 1;
        }
      } catch (error) {
        stats.sourceFailures += 1;
        console.warn(`${source.type === "website" ? "Website" : "RSS"} ${source.name}: ${error.message}`);
      }
      }
  } finally {
    syncInProgress = false;
  }
  return { imported: imported.length, articles: imported, stats };
}
app.post("/api/admin/sync", staffRequired, async (req, res) => {
  if (!allProviders().length) return res.status(400).json({ error: "Voeg eerst minstens één actieve AI-provider toe." });
  const result = await syncNews();
  res.json(result);
});
app.post("/api/admin/generate", staffRequired, async (req, res) => {
  const topic = String(req.body.topic || "").trim();
  if (topic.length < 3) return res.status(400).json({ error: "Vul minimaal drie tekens in." });
  const result = await rewriteWithFallback(`Schrijf een ${req.body.tone || "helder"} nieuwsartikel over: ${topic}`);
  if (!result) return res.status(502).json({ error: "Alle actieve AI-providers zijn mislukt." });
  res.json({ article: result.article });
});
app.get("/api/articles", (req, res) => {
  recordVisitor(req, res);
  const token = sessionToken(req);
  const user = token ? db.prepare("SELECT users.id, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?").get(hash(token)) : null;
  res.json(db.prepare("SELECT * FROM articles ORDER BY timestamp DESC LIMIT 100").all().map((article) => publicArticle(article, user)));
});
app.get("/api/stats", (req, res) => {
  recordVisitor(req, res);
  res.json(homepageStats());
});
app.get("/api/rss", (req, res) => {
  const apiKey = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const owner = apiKey ? db.prepare("SELECT users.id, users.role FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.key_hash = ?").get(hash(apiKey)) : null;
  if (!owner || (!hasActiveSubscription(owner.id) && owner.role !== "staff")) return res.status(401).json({ error: "Een geldig abonnement en API-key zijn vereist." });
  db.prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?").run(hash(apiKey));
  res.type("application/rss+xml").send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NieuwsFlits</title><link>${process.env.PUBLIC_URL || "http://localhost:4173"}</link><description>NieuwsFlits-artikelen voor abonnees</description>${db.prepare("SELECT * FROM articles ORDER BY timestamp DESC LIMIT 100").all().map((article) => `<item><title><![CDATA[${article.title}]]></title><link>${article.url || ""}</link><description><![CDATA[${article.body}]]></description><pubDate>${new Date(article.timestamp).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`);
});
app.get("/api/account/api-keys", authRequired, (req, res) => {
  if (!hasActiveSubscription(req.user.id) && req.user.role !== "staff") return res.status(402).json({ error: "Een actief abonnement is vereist." });
  res.json({ keys: db.prepare("SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at").all(req.user.id) });
});
app.post("/api/account/api-keys", subscriberRequired, (req, res) => {
  const plain = `nai_${crypto.randomBytes(24).toString("hex")}`;
  const record = { id: crypto.randomUUID(), name: String(req.body.name || "NieuwsFlits API-key").trim() || "NieuwsFlits API-key", key_prefix: plain.slice(0, 12) };
  db.prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)").run(record.id, req.user.id, record.name, hash(plain), record.key_prefix);
  res.status(201).json({ ...record, key: plain });
});
app.delete("/api/account/api-keys/:id", authRequired, (req, res) => { db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id); res.json({ ok: true }); });
app.post("/api/billing/checkout", authRequired, async (req, res) => {
  const stripe = getStripe();
  const stripePriceId = getSetting("stripe_price_id");
  if (!stripe || !stripePriceId) return res.status(503).json({ error: "Stripe is nog niet geconfigureerd. Vul de Stripe-gegevens in het staff-paneel in." });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const session = await stripe.checkout.sessions.create({ mode: "subscription", customer_email: user.email, client_reference_id: String(user.id), line_items: [{ price: stripePriceId, quantity: 1 }], success_url: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/?subscription=success`, cancel_url: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/?subscription=cancelled`, metadata: { userId: String(user.id) } });
  res.json({ url: session.url });
});
app.post("/api/account/share", subscriberRequired, async (req, res) => {
  if (!hasOwnActiveSubscription(req.user.id)) return res.status(403).json({ error: "Alleen de eigenaar van een eigen abonnement kan toegang delen." });
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
  const count = db.prepare("SELECT COUNT(*) AS count FROM subscription_shares WHERE owner_user_id = ?").get(req.user.id).count;
  if (count >= 5) return res.status(400).json({ error: "Je kunt je abonnement met maximaal vijf mensen delen." });
  try {
    db.prepare("INSERT INTO subscription_shares (id, owner_user_id, email) VALUES (?, ?, ?)").run(crypto.randomUUID(), req.user.id, email);
    await sendMail(email, "Je hebt een gratis NieuwsFlits-abonnement ontvangen", "Je kunt nu gratis een NieuwsFlits-account aanmaken. Gebruik hetzelfde e-mailadres om je uitnodiging te activeren.");
    res.status(201).json({ email, status: "pending" });
  } catch { res.status(409).json({ error: "Dit e-mailadres is al uitgenodigd." }); }
});
app.delete("/api/account/shares/:id", subscriberRequired, (req, res) => {
  const share = db.prepare("SELECT id, invited_user_id FROM subscription_shares WHERE id = ? AND owner_user_id = ?").get(req.params.id, req.user.id);
  if (!share) return res.status(404).json({ error: "Gedeelde toegang niet gevonden." });
  db.prepare("UPDATE subscription_shares SET status = 'revoked' WHERE id = ?").run(share.id);
  db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE source_share_id = ? AND plan = 'shared'").run(share.id);
  res.json({ ok: true });
});

const syncIntervalMinutes = Math.max(1, Number(process.env.NEWS_SYNC_INTERVAL_MINUTES || 60));
const syncOnStart = process.env.NEWS_SYNC_ON_START !== "false";
const scheduler = async (trigger) => {
  const result = await syncNews();
  if (result.reason === "no_provider") console.log(`[scheduler] ${trigger}: overgeslagen, geen actieve AI-provider.`);
  else if (result.reason === "already_running") console.log(`[scheduler] ${trigger}: vorige sync draait nog.`);
  else console.log(`[scheduler] ${trigger}: ${result.imported} nieuwe artikelen opgeslagen.`);
};

app.listen(PORT, () => {
  console.log(`NieuwsFlits server draait op http://localhost:${PORT}`);
  console.log(`Nieuws-scheduler: elke ${syncIntervalMinutes} minuut/minuten${syncOnStart ? ", inclusief bij opstart" : ""}.`);
  if (syncOnStart) scheduler("opstart").catch((error) => console.error("[scheduler] opstart mislukt:", error.message));
  setInterval(() => scheduler("interval").catch((error) => console.error("[scheduler] interval mislukt:", error.message)), syncIntervalMinutes * 60 * 1000);
});
