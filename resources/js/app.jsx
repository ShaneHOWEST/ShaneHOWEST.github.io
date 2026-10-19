import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../css/app.css";

function App() {
  const [articles, setArticles] = useState([]);
  const [stats, setStats] = useState({ totalArticles: 0, newArticlesToday: 0, readersToday: 0 });
  const [user, setUser] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [adminOpen, setAdminOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState(null);
  const [accountData, setAccountData] = useState(null);
  const [accountForm, setAccountForm] = useState({ email: "", current_password: "", new_password: "", new_password_confirmation: "" });
  const [admin, setAdmin] = useState({ sources: [], providers: [], users: [] });
  const [login, setLogin] = useState({ email: "", password: "" });
  const [signup, setSignup] = useState({ email: "", password: "", confirmation: "" });
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadArticles = () => fetch("/api/articles", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json());
    Promise.all([loadArticles(), fetch("/api/stats", { cache: "no-store" }).then((r) => r.json())])
      .then(([news, values]) => { setArticles(news); setStats(values); })
      .catch(() => setError("Nieuws kon niet worden geladen."))
      .finally(() => setLoading(false));
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((currentUser) => {
      setUser(currentUser);
      return loadArticles().then(setArticles);
    });
    const subscription = new URLSearchParams(window.location.search).get("subscription");
    if (subscription === "success") setNotice("Betaling gestart. Je abonnement wordt geactiveerd zodra Stripe de webhook heeft verwerkt.");
    if (subscription === "cancelled") {
      setNotice("De betaling is geannuleerd. Je abonnement is niet geactiveerd.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    const token = new URLSearchParams(window.location.search).get("verify");
    if (token) fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ token }) })
      .then(async (r) => { const payload = await r.json(); if (!r.ok) throw new Error(payload.error); setUser(payload); setNotice("Je e-mailadres is bevestigd."); window.history.replaceState({}, "", window.location.pathname); })
      .catch((e) => setNotice(e.message || "Verificatie mislukt."));
  }, []);

  async function signIn(event) {
    event.preventDefault();
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(login) });
    const payload = await response.json();
    if (!response.ok) return setNotice(payload.error || "Inloggen mislukt.");
    setUser(payload); setLoginOpen(false); setNotice("");
  }

  async function register(event) {
    event.preventDefault();
    if (signup.password !== signup.confirmation) return setNotice("De wachtwoorden komen niet overeen.");
    const response = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email: signup.email, password: signup.password }) });
    const payload = await response.json();
    if (!response.ok) return setNotice(payload.message || payload.error || "Registreren mislukt.");
    setNotice("Account aangemaakt. Controleer je e-mail om je account te bevestigen.");
    setAuthMode("login");
  }

  async function openAdmin() {
    if (!user) return setLoginOpen(true);
    const response = await fetch("/api/admin/config", { credentials: "same-origin" });
    if (!response.ok) return setNotice("Alleen staff-gebruikers hebben toegang tot het beheer.");
    const config = await response.json();
    const users = await fetch("/api/admin/users", { credentials: "same-origin" }).then((r) => r.json());
    setAdmin({ ...config, users: users.users || [] }); setAdminOpen(true);
  }

  async function addProvider(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/admin/providers", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(data) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const details = payload.errors ? Object.values(payload.errors).flat().join(" ") : payload.error;
      return setNotice(details || "AI-provider kon niet worden opgeslagen.");
    }
    const provider = await response.json();
    setAdmin((current) => ({ ...current, providers: [...current.providers, provider] }));
    event.currentTarget.reset();
  }

  async function adminAction(path, method, body) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Beheeractie mislukt.");
    return payload;
  }

  async function refreshAdmin() {
    const [config, users] = await Promise.all([
      fetch("/api/admin/config", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/api/admin/users", { credentials: "same-origin" }).then((r) => r.json()),
    ]);
    setAdmin({ ...config, users: users.users || [] });
  }

  async function addSource(event) {
    event.preventDefault();
    try { await adminAction("/api/admin/sources", "POST", Object.fromEntries(new FormData(event.currentTarget))); event.currentTarget.reset(); await refreshAdmin(); setNotice("Nieuwsbron toegevoegd."); } catch (e) { setNotice(e.message); }
  }

  async function createUser(event) {
    event.preventDefault();
    try { await adminAction("/api/admin/users", "POST", Object.fromEntries(new FormData(event.currentTarget))); event.currentTarget.reset(); await refreshAdmin(); setNotice("Gebruiker aangemaakt."); } catch (e) { setNotice(e.message); }
  }

  async function assignSubscription(event, id) {
    event.preventDefault();
    try {
      await adminAction(`/api/admin/users/${id}/subscription`, "POST", Object.fromEntries(new FormData(event.currentTarget)));
      await refreshAdmin();
      setNotice("Abonnement toegewezen.");
    } catch (e) { setNotice(e.message); }
  }

  async function revokeAdminSubscription(id) {
    try {
      await adminAction(`/api/admin/users/${id}/subscription`, "DELETE");
      await refreshAdmin();
      setNotice("Beheerd abonnement ingetrokken.");
    } catch (e) { setNotice(e.message); }
  }

  async function saveIntegrations(event) {
    event.preventDefault();
    try { await adminAction("/api/admin/integrations", "PUT", Object.fromEntries(new FormData(event.currentTarget))); await refreshAdmin(); setNotice("Betalings- en mailgegevens opgeslagen."); } catch (e) { setNotice(e.message); }
  }

  async function syncNews() {
    try { const result = await adminAction("/api/admin/sync", "POST"); setNotice(`${result.discovered || 0} bronitems gecontroleerd, ${result.providerFailures || 0} AI-fouten.`); } catch (e) { setNotice(e.message); }
  }

  async function startCheckout() {
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST", credentials: "same-origin" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Stripe kon niet worden gestart.");
      window.location.href = payload.url;
    } catch (e) { setNotice(e.message); }
  }

  async function openAccount() {
    const response = await fetch("/api/account", { credentials: "same-origin" });
    if (!response.ok) return setNotice("Log eerst in om je account te beheren.");
    const data = await response.json();
    setAccountData(data);
    setAccountForm((current) => ({ ...current, email: data.user.email }));
    setAccountOpen(true);
  }

  async function saveAccount(event) {
    event.preventDefault();
    const response = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(accountForm) });
    const payload = await response.json();
    if (!response.ok) return setNotice(payload.error || "Account kon niet worden bijgewerkt.");
    setUser((current) => ({ ...current, email: payload.email }));
    setAccountForm({ email: payload.email, current_password: "", new_password: "", new_password_confirmation: "" });
    setNotice(payload.verificationRequired ? "E-mailadres gewijzigd. Bevestig het nieuwe adres via e-mail." : "Account bijgewerkt.");
    openAccount();
  }

  async function shareSubscription(event) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    const response = await fetch("/api/account/share", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email }) });
    const payload = await response.json();
    if (!response.ok) return setNotice(payload.error || "Uitnodiging kon niet worden verstuurd.");
    event.currentTarget.reset();
    setNotice("Uitnodiging verstuurd.");
    openAccount();
  }

  async function revokeShare(id) {
    const response = await fetch(`/api/account/shares/${id}`, { method: "DELETE", credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) return setNotice(payload.error || "Toegang kon niet worden ingetrokken.");
    setNotice("Gedeelde toegang ingetrokken.");
    openAccount();
  }

  return <main className="shell">
    <header><a className="brand" href="/"><img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true"/><span>NieuwsFlits</span></a><nav><a href="#latest">Laatste nieuws</a><a href="#topics">Onderwerpen</a>{user?.role === "staff" && <button onClick={openAdmin}>⚙ Beheer</button>}{user ? <><button onClick={openAccount}>Mijn account</button><button onClick={startCheckout}>Abonneren</button><button onClick={async () => { await fetch("/api/auth/logout",{method:"POST"}); setUser(null); }}>Uitloggen</button></> : <><button onClick={() => { setAuthMode("login"); setLoginOpen(true); }}>Inloggen</button><button className="nav-primary" onClick={() => { setAuthMode("signup"); setLoginOpen(true); }}>Registreren</button></>}</nav></header>
    <section className="hero"><p className="eyebrow">VERS VAN DE REDACTIE</p><h1>Het nieuws,<br/><em>helder gemaakt.</em></h1><p>NieuwsFlits combineert menselijke nieuwsgierigheid met de snelheid van AI. Feiten, context en het verhaal erachter.</p><div className="stats"><strong>{stats.newArticlesToday}<small>nieuwe verhalen</small></strong><strong>{stats.readersToday}<small>lezers vandaag</small></strong></div></section>
    <section id="latest" className="content"><div className="section-head"><div><p className="eyebrow">JOUW OVERZICHT</p><h2>Voor jou geselecteerd</h2></div><span>{articles.length} verhalen</span></div>
      {loading && <p className="state">Nieuws wordt geladen…</p>}{error && <p className="state error">{error}</p>}{!loading && !error && !articles.length && <p className="state">Nog geen nieuwsartikelen.</p>}
      <div className="grid">{articles.map((article) => <article className="card" key={article.id}><p className="eyebrow">{article.category}</p><time>{new Date(article.timestamp).toLocaleString("nl-NL")}</time><h3>{article.title}</h3><p>{article.excerpt}</p><small>{article.locked ? "Abonnement vereist" : "Volledig artikel"} · 5 min lezen</small><button className={article.locked ? "auth-switch read-button" : "primary read-button"} onClick={() => article.locked ? startCheckout() : setArticleOpen(article)}>{article.locked ? "Abonneren om te lezen" : "Volledig lezen"}</button></article>)}</div>
    </section>
    {notice && <div className="notice">{notice}</div>}
    {articleOpen && <div className="modal" onClick={(event) => event.target === event.currentTarget && setArticleOpen(null)}><article className="panel article-panel"><button type="button" className="close" onClick={() => setArticleOpen(null)}>×</button><p className="eyebrow">{articleOpen.category}</p><time>{new Date(articleOpen.timestamp).toLocaleString("nl-NL")} · Bron: {articleOpen.source || articleOpen.source_name || "NieuwsFlits-redactie"}</time><h2>{articleOpen.title}</h2><p className="article-body">{articleOpen.body}</p></article></div>}
    {loginOpen && <div className="modal"><form onSubmit={authMode === "login" ? signIn : register} className="panel"><button type="button" className="close" onClick={() => setLoginOpen(false)}>×</button><p className="eyebrow">ACCOUNT</p><h2>{authMode === "login" ? "Inloggen" : "Account registreren"}</h2>{authMode === "login" ? <><input type="email" placeholder="E-mailadres" value={login.email} onChange={(e) => setLogin({...login,email:e.target.value})} required/><input type="password" placeholder="Wachtwoord" value={login.password} onChange={(e) => setLogin({...login,password:e.target.value})} required/><button className="primary" type="submit">Inloggen</button><button className="auth-switch" type="button" onClick={() => setAuthMode("signup")}>Nog geen account? Registreren</button></> : <><input type="email" placeholder="E-mailadres" value={signup.email} onChange={(e) => setSignup({...signup,email:e.target.value})} required/><input type="password" minLength="10" placeholder="Wachtwoord (minimaal 10 tekens)" value={signup.password} onChange={(e) => setSignup({...signup,password:e.target.value})} required/><input type="password" minLength="10" placeholder="Wachtwoord herhalen" value={signup.confirmation} onChange={(e) => setSignup({...signup,confirmation:e.target.value})} required/><button className="primary" type="submit">Account aanmaken</button><button className="auth-switch" type="button" onClick={() => setAuthMode("login")}>Al een account? Inloggen</button></>}</form></div>}
    {accountOpen && <div className="modal" onClick={(event) => event.target === event.currentTarget && setAccountOpen(false)}><section className="panel account-panel"><button type="button" className="close" onClick={() => setAccountOpen(false)}>×</button><p className="eyebrow">MIJN ACCOUNT</p><h2>Account beheren</h2><p className="account-muted">Beheer je profiel, wachtwoord en abonnement.</p><form onSubmit={saveAccount}><label>E-mailadres</label><input type="email" value={accountForm.email} onChange={(e) => setAccountForm({...accountForm,email:e.target.value})} required/><label>Huidig wachtwoord <small>(alleen nodig bij wijzigen wachtwoord)</small></label><input type="password" value={accountForm.current_password} onChange={(e) => setAccountForm({...accountForm,current_password:e.target.value})}/><label>Nieuw wachtwoord</label><input type="password" minLength="10" value={accountForm.new_password} onChange={(e) => setAccountForm({...accountForm,new_password:e.target.value})} placeholder="Minimaal 10 tekens"/><label>Nieuw wachtwoord herhalen</label><input type="password" minLength="10" value={accountForm.new_password_confirmation} onChange={(e) => setAccountForm({...accountForm,new_password_confirmation:e.target.value})}/><button className="primary" type="submit">Gegevens opslaan</button></form><div className="account-summary"><strong>Abonnement</strong><span>{accountData?.subscribed ? `Actief${accountData.subscription?.current_period_end ? ` tot ${new Date(accountData.subscription.current_period_end).toLocaleDateString("nl-NL")}` : ""}` : "Geen actief abonnement"}</span>{!accountData?.subscribed && <button className="auth-switch" onClick={startCheckout}>Abonnement kiezen</button>}</div>{accountData?.subscription?.plan !== "shared" && accountData?.subscribed && <div className="share-box"><strong>Deel je eigen abonnement</strong><p>Je kunt maximaal vijf personen uitnodigen. Gedeelde gebruikers kunnen niet verder delen.</p><form onSubmit={shareSubscription}><input name="email" type="email" placeholder="vriend@voorbeeld.nl" required/><button className="primary" type="submit">Gratis abonnement delen</button></form>{accountData.shares?.map((share) => <div className="share-row" key={share.id}><span>{share.email}<small>{share.status === "accepted" ? "Geaccepteerd" : share.status === "revoked" ? "Ingetrokken" : "Uitnodiging open"}</small></span>{["pending","accepted"].includes(share.status) && <button className="auth-switch" onClick={() => revokeShare(share.id)}>Intrekken</button>}</div>)}</div>}</section></div>}
    {adminOpen && <div className="admin-overlay" onClick={(event) => event.target === event.currentTarget && setAdminOpen(false)}><section className="admin-panel" role="dialog" aria-modal="true"><button className="admin-close" onClick={() => setAdminOpen(false)} aria-label="Beheer sluiten">×</button><div className="admin-heading"><p className="eyebrow">NieuwsFlits control room</p><h2>Beheer &amp; integraties</h2><p>Beheer de bronnen waaruit je redactie leest en verbind een echte AI-provider.</p></div><div className={`admin-status ${admin.providers.length ? "ready" : ""}`}><span/> {admin.providers.length ? `${admin.providers.length} AI-provider${admin.providers.length === 1 ? "" : "s"} geconfigureerd` : "AI-provider nog niet geconfigureerd"}</div>
      <section className="admin-section"><div className="admin-section-heading"><h3>Gebruikers &amp; abonnementen</h3><p>Maak accounts aan en wijs standaard drie maanden volledige toegang toe.</p></div><form className="admin-user-form" onSubmit={createUser}><input name="email" type="email" placeholder="redactie@voorbeeld.nl" required/><input name="password" type="password" minLength="10" placeholder="Minimaal 10 tekens" required/><button className="admin-submit">Gebruiker aanmaken</button></form><div className="admin-list">{admin.users.map((item) => <div className="admin-row admin-user-row" key={item.id}><span className="user-avatar">{item.email.slice(0, 2).toUpperCase()}</span><div><strong>{item.email}</strong><small>{item.role} · {new Date(item.created_at).toLocaleDateString("nl-NL")}</small>{item.admin_subscription_id && <small className="subscription-active">Beheerd abonnement{item.admin_subscription_end ? ` tot ${new Date(item.admin_subscription_end).toLocaleDateString("nl-NL")}` : ""}</small>}<form className="subscription-form" onSubmit={(event) => assignSubscription(event, item.id)}><button className="admin-submit">{item.admin_subscription_id ? "Verlengen met 3 maanden" : "3 maanden toewijzen"}</button></form></div><div className="admin-row-actions">{item.admin_subscription_id && <button className="admin-revoke" onClick={() => revokeAdminSubscription(item.id)}>Intrekken</button>}{item.email !== user?.email && <button onClick={async () => { await adminAction(`/api/admin/users/${item.id}`, "DELETE"); refreshAdmin(); }} aria-label="Gebruiker verwijderen">×</button>}</div></div>)}</div><p className="admin-help">Alle nieuwe abonnementen duren standaard drie maanden. Beheerde abonnementen wijzigen geen Stripe-abonnementen.</p></section>
      <section className="admin-section"><div className="admin-section-heading"><h3>Nieuwsbronnen</h3><p>Voeg een RSS-feed of nieuwswebsite toe.</p></div><form className="admin-source-form" onSubmit={addSource}><input name="name" placeholder="Naam, bijv. NOS Nieuws" required/><select name="type"><option value="rss">RSS/Atom-feed</option><option value="website">Website uitlezen</option></select><input name="url" type="url" placeholder="https://voorbeeld.nl/feed.xml" required/><button className="admin-submit">Bron toevoegen</button></form><div className="admin-list">{admin.sources.map((item) => <div className="admin-row" key={item.id}><i className="source-dot"/><div><strong>{item.name} <em>{item.type === "website" ? "website" : "RSS"}</em></strong><small>{item.url}</small></div><button onClick={async () => { await adminAction(`/api/admin/sources/${item.id}`, "DELETE"); refreshAdmin(); }} aria-label="Bron verwijderen">×</button></div>)}</div></section>
      <section className="admin-section"><div className="admin-section-heading"><h3>AI-provider</h3><p>Providers worden op prioriteit geprobeerd; bij fouten valt de server terug. Bekende providers krijgen standaardwaarden voor endpoint en model.</p></div><form className="admin-provider-form" onSubmit={addProvider}><label>Provider</label><select name="type"><option value="openai">OpenAI-compatible API</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="custom">Custom endpoint</option></select><label>Naam</label><input name="name" placeholder="Bijv. Gemini productie" required/><label>API endpoint</label><input name="url" type="url" placeholder="https://... (optioneel bij bekende provider)"/><label>Model</label><input name="model" placeholder="bijv. gpt-4o-mini (optioneel bij bekende provider)"/><label>API-key</label><input name="apiKey" type="password" required autoComplete="off"/><button className="admin-submit">Configuratie opslaan</button></form><div className="admin-list">{admin.providers.map((item) => <div className="admin-row" key={item.id}><i className="provider-dot"/><div><strong>{item.name}</strong><small>{item.type} · {item.model} · prioriteit {item.priority} · API-key ingesteld</small><small>{item.url}</small></div><button onClick={async () => { await adminAction(`/api/admin/providers/${item.id}`, "DELETE"); refreshAdmin(); }} aria-label="Provider verwijderen">×</button></div>)}</div><button className="sync-button" onClick={syncNews}>Bronnen ophalen &amp; artikelen herschrijven</button><p className="security-note"><strong>Beveiligd:</strong> credentials worden server-side opgeslagen.</p></section>
      <section className="admin-section"><div className="admin-section-heading"><h3>Betalingen &amp; e-mail</h3><p>Pas Stripe Checkout, webhooks en verificatiemails aan.</p></div><form className="admin-provider-form" onSubmit={saveIntegrations}><h4>Stripe</h4><label>Secret key</label><input name="stripe_secret_key" type="password" placeholder="sk_test_…"/><label>Price ID</label><input name="stripe_price_id" placeholder="price_…"/><label>Webhook signing secret</label><input name="stripe_webhook_secret" type="password" placeholder="whsec_…"/><h4>SMTP</h4><label>Host</label><input name="smtp_host" placeholder="smtp.example.com"/><label>Poort</label><input name="smtp_port" type="number" placeholder="587"/><label>Beveiligde verbinding</label><select name="smtp_secure"><option value="false">STARTTLS / niet direct TLS</option><option value="true">Direct TLS</option></select><label>Gebruikersnaam</label><input name="smtp_user"/><label>Wachtwoord</label><input name="smtp_password" type="password"/><label>Afzender</label><input name="smtp_from" placeholder="NieuwsFlits <no-reply@voorbeeld.nl>"/><button className="admin-submit">Betalings- en mailgegevens opslaan</button></form><p className="security-note"><strong>Let op:</strong> geheime sleutels worden niet teruggestuurd naar de browser.</p></section>
    </section></div>}
  </main>;
}

createRoot(document.getElementById("app")).render(<App />);
