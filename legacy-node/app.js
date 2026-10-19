const state = { category: "Alles", query: "", sort: "newest" };
const newsGrid = document.querySelector("#newsGrid");
const resultCount = document.querySelector("#resultCount");
const emptyState = document.querySelector("#emptyState");
const searchOverlay = document.querySelector("#searchOverlay");
const searchInput = document.querySelector("#searchInput");
const toast = document.querySelector("#toast");
const formatStat = (value) => new Intl.NumberFormat("nl-NL", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));

let liveNews = [];
let currentUser = null;
function renderNews() {
  const allStories = liveNews.length ? [...liveNews, ...NEWS_DATA] : NEWS_DATA;
  let stories = allStories.filter((story) => state.category === "Alles" || story.category === state.category)
    .filter((story) => {
      const haystack = `${story.title} ${story.excerpt} ${story.source} ${story.category}`.toLowerCase();
      return !state.query || haystack.includes(state.query.toLowerCase());
    });
  if (state.sort === "read") stories = [...stories].sort((a, b) => b.reads - a.reads);
  else stories = [...stories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  resultCount.textContent = `${stories.length} ${stories.length === 1 ? "verhaal" : "verhalen"}`;
  newsGrid.innerHTML = stories.map((story, index) => `
    <article class="news-card ${index === 0 ? "featured-card" : ""}" data-article-id="${escapeHTML(story.id || "")}" tabindex="0">
      <div class="story-art art-${story.color}"><span>${story.icon}</span><div class="art-lines"></div></div>
      <div class="card-content">
        <div class="card-meta"><span class="category-label">${story.category}</span><span>${story.time}</span></div>
        <h3>${story.title}</h3>
        <p>${story.excerpt}${story.locked ? " <strong class=\"locked-copy\">Lees verder met een abonnement</strong>" : ""}</p>
        <div class="card-footer"><span>${story.readTime}</span></div>
      </div>
    </article>
  `).join("");
  emptyState.classList.toggle("hidden", stories.length > 0);
  newsGrid.classList.toggle("hidden", stories.length === 0);
  newsGrid.querySelectorAll("[data-article-id]").forEach((card) => {
    const open = () => openArticle(stories.find((story) => String(story.id) === card.dataset.articleId));
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 2800);
}

function openSearch() {
  searchOverlay.classList.remove("hidden");
  window.setTimeout(() => searchInput.focus(), 50);
}
function closeSearch() {
  searchOverlay.classList.add("hidden");
}
const articleOverlay = document.querySelector("#articleOverlay");
function openArticle(article) {
  if (!article) return;
  document.querySelector("#articleCategory").textContent = article.category || "Nieuws";
  document.querySelector("#articleTitle").textContent = article.title;
  document.querySelector("#articleMeta").textContent = article.time || new Date(article.timestamp).toLocaleString("nl-NL");
  document.querySelector("#articleBody").textContent = article.body || article.excerpt || "";
  document.querySelector("#articlePaywall").classList.toggle("hidden", !article.locked);
  articleOverlay.classList.remove("hidden");
}
document.querySelector("#closeArticle").addEventListener("click", () => articleOverlay.classList.add("hidden"));
articleOverlay.addEventListener("click", (event) => { if (event.target === articleOverlay) articleOverlay.classList.add("hidden"); });
document.querySelector("#articleSubscribe").addEventListener("click", () => { articleOverlay.classList.add("hidden"); accountOverlay.classList.remove("hidden"); refreshAuth().then(renderAccount); });

document.querySelectorAll(".topic-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(".topic-button.active").classList.remove("active");
    button.classList.add("active");
    state.category = button.dataset.category;
    renderNews();
  });
});
document.querySelector("#sortSelect").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderNews();
});
document.querySelector("#searchTrigger").addEventListener("click", openSearch);
document.querySelector("#closeSearch").addEventListener("click", closeSearch);
searchOverlay.addEventListener("click", (event) => {
  if (event.target === searchOverlay) closeSearch();
});
searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderNews();
});
document.querySelector("#clearSearch").addEventListener("click", () => {
  state.query = "";
  searchInput.value = "";
  closeSearch();
  renderNews();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
  if (event.key === "Escape") closeSearch();
});

const adminOverlay = document.querySelector("#adminOverlay");
const sourceList = document.querySelector("#sourceList");
const adminStatus = document.querySelector("#adminStatus");
async function adminFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { adminOverlay.classList.add("hidden"); document.querySelector("#loginOverlay").classList.remove("hidden"); throw new Error("Authenticatie vereist."); }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Beheeractie mislukt.");
  return payload;
}
async function renderAdmin() {
  const config = await adminFetch("/api/admin/config");
  const userData = await adminFetch("/api/admin/users");
  const currentEmail = (await adminFetch("/api/auth/me")).email;
  document.querySelector("#userList").innerHTML = userData.users.map((user) => `<div class="user-row"><div class="user-avatar">${escapeHTML(user.email.slice(0, 2).toUpperCase())}</div><div><strong>${escapeHTML(user.email)}</strong><small>${user.email === currentEmail ? "Jij · " : ""}Aangemaakt op ${new Date(user.created_at).toLocaleDateString("nl-NL")}</small></div>${user.email === currentEmail ? "" : `<button type="button" data-user-id="${user.id}" aria-label="Gebruiker verwijderen">×</button>`}</div>`).join("");
  document.querySelectorAll("[data-user-id]").forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("Deze gebruiker verwijderen?")) return; try { await adminFetch(`/api/admin/users/${button.dataset.userId}`, { method: "DELETE" }); await renderAdmin(); showToast("Gebruiker verwijderd"); } catch (error) { showToast(error.message); } }));
  sourceList.innerHTML = config.sources.length ? config.sources.map((source) => `<div class="source-row"><span class="source-indicator"></span><div><strong>${escapeHTML(source.name)} <em>${source.type === "website" ? "website" : "RSS"}</em></strong><small>${escapeHTML(source.url)}</small></div><button type="button" data-source-id="${source.id}" aria-label="Bron verwijderen">×</button></div>`).join("") : '<p class="admin-empty">Nog geen bronnen toegevoegd.</p>';
  sourceList.querySelectorAll("[data-source-id]").forEach((button) => button.addEventListener("click", async () => { await adminFetch(`/api/admin/sources/${button.dataset.sourceId}`, { method: "DELETE" }); renderAdmin(); showToast("Nieuwsbron verwijderd"); }));
  const providerList = document.querySelector("#providerList");
  providerList.innerHTML = config.providers.length ? config.providers.map((provider) => `<div class="provider-row"><span class="provider-status ${provider.enabled ? "active" : "inactive"}"></span><div><strong>${escapeHTML(provider.name)}</strong><small>${escapeHTML(provider.type)} · ${escapeHTML(provider.model)} · prioriteit ${provider.priority} · API-key ingesteld</small><small>${escapeHTML(provider.url)}</small></div><button type="button" data-provider-id="${provider.id}" aria-label="AI-provider verwijderen">×</button></div>`).join("") : '<p class="admin-empty">Nog geen AI-providers toegevoegd.</p>';
  providerList.querySelectorAll("[data-provider-id]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm("Deze AI-provider verwijderen?")) return;
    try { await adminFetch(`/api/admin/providers/${button.dataset.providerId}`, { method: "DELETE" }); await renderAdmin(); showToast("AI-provider verwijderd"); }
    catch (error) { showToast(error.message); }
  }));
  const ready = config.providers.length > 0;
  adminStatus.className = `admin-status ${ready ? "ready" : "warning"}`;
  adminStatus.innerHTML = `<span></span> ${ready ? `${config.providers.length} AI-provider${config.providers.length === 1 ? "" : "s"} geconfigureerd` : "AI-provider nog niet geconfigureerd"}`;
  const integrations = config.integrations;
  for (const [name, value] of Object.entries(integrations)) {
    const field = document.querySelector(`#${name}`);
    if (field) field.value = value || "";
  }
}
document.querySelector("#adminButton").addEventListener("click", async () => {
  try { await adminFetch("/api/auth/me"); adminOverlay.classList.remove("hidden"); await renderAdmin(); }
  catch (error) { if (error.message !== "Authenticatie vereist.") showToast(error.message); }
});
document.querySelector("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await adminFetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email.value, password: form.password.value }) });
    form.reset();
    await renderAdmin();
    showToast("Gebruiker aangemaakt");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#closeAdmin").addEventListener("click", () => adminOverlay.classList.add("hidden"));
adminOverlay.addEventListener("click", (event) => { if (event.target === adminOverlay) adminOverlay.classList.add("hidden"); });
document.querySelector("#sourceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const selectedType = form.elements.namedItem("type").value;
  try {
    await adminFetch("/api/admin/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.name.value.trim(), url: form.url.value.trim(), type: selectedType }),
    });
    form.elements.namedItem("name").value = "";
    form.elements.namedItem("url").value = "";
    form.elements.namedItem("type").value = selectedType;
    await renderAdmin();
    showToast(selectedType === "website" ? "Websitebron toegevoegd" : "RSS-bron toegevoegd");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#providerForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  adminFetch("/api/admin/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.provider.options[form.provider.selectedIndex].text, type: form.provider.value, url: form.url.value.trim(), model: form.model.value.trim(), apiKey: form.key.value.trim(), priority: 1 }) }).then(() => { form.reset(); renderAdmin(); showToast("AI-configuratie opgeslagen"); }).catch((error) => showToast(error.message));
});
document.querySelector("#providerName").addEventListener("change", (event) => {
  if (event.target.value === "openai") document.querySelector("#providerUrl").value = "https://api.openai.com/v1/chat/completions";
  if (event.target.value === "gemini") document.querySelector("#providerUrl").value = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
  if (event.target.value === "anthropic") document.querySelector("#providerUrl").value = "https://api.anthropic.com/v1/messages";
});
document.querySelector("#integrationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await adminFetch("/api/admin/integrations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await renderAdmin();
    showToast("Stripe- en mailgegevens opgeslagen");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#syncButton").addEventListener("click", async () => {
  const button = document.querySelector("#syncButton"); button.disabled = true; button.textContent = "Bronnen ophalen en herschrijven…";
  try {
    const result = await adminFetch("/api/admin/sync", { method: "POST" });
    const stats = result.stats || {};
    const detail = stats.duplicates ? ` ${stats.duplicates} al verwerkt.` : stats.providerFailures ? ` ${stats.providerFailures} AI-fout${stats.providerFailures === 1 ? "" : "en"}.` : "";
    showToast(`${result.imported} nieuwe artikelen.${detail}`);
  } catch (error) { showToast(error.message); } finally { button.disabled = false; button.textContent = "Bronnen ophalen & artikelen herschrijven"; }
});
document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try { await adminFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.querySelector("#loginEmail").value, password: form.querySelector("#loginPassword").value }) }); document.querySelector("#loginOverlay").classList.add("hidden"); adminOverlay.classList.remove("hidden"); await renderAdmin(); showToast("Inloggen geslaagd"); } catch (error) { showToast(error.message); }
});

document.querySelector("#menuButton").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const nav = document.querySelector(".main-nav");
  const open = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!open));
  nav.classList.toggle("mobile-open", !open);
});

async function refreshAuth() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) throw new Error("not-authenticated");
    currentUser = await response.json();
    if (currentUser.role === "staff") document.querySelector("#adminButton").classList.remove("hidden");
    document.querySelector("#accountButton").textContent = currentUser.email.slice(0, 2).toUpperCase();
  } catch {
    currentUser = null;
    document.querySelector("#adminButton").classList.add("hidden");
  }
}
async function loadArticles() {
  try {
    const articles = await (await fetch("/api/articles")).json();
    liveNews = articles.map((article) => ({ ...article, time: new Date(article.timestamp).toLocaleString("nl-NL"), readTime: "5 min lezen", color: "blue", icon: article.locked ? "🔒" : "✦", reads: 0 }));
    renderNews();
  } catch {}
}
async function loadStats() {
  try {
    const response = await fetch("/api/stats");
    if (!response.ok) throw new Error("Statistieken konden niet worden geladen.");
    const stats = await response.json();
    document.querySelector("#newArticlesStat").textContent = formatStat(stats.newArticlesToday);
    document.querySelector("#readersStat").textContent = formatStat(stats.readersToday);
  } catch {
    document.querySelector("#newArticlesStat").textContent = "0";
    document.querySelector("#readersStat").textContent = "0";
  }
}
const accountOverlay = document.querySelector("#accountOverlay");
async function renderAccount() {
  if (!currentUser) {
    document.querySelector("#authActions").classList.remove("hidden");
    document.querySelector("#accountContent").classList.add("hidden");
    document.querySelector("#accountStatus").textContent = "Log in of maak een account aan om je abonnement te beheren.";
    return;
  }
  document.querySelector("#authActions").classList.add("hidden");
  document.querySelector("#accountContent").classList.remove("hidden");
  const account = await (await fetch("/api/account")).json();
  document.querySelector("#accountStatus").textContent = account.sharedSubscribed ? "Je gebruikt een gedeeld abonnement. Je kunt een eigen abonnement nemen om zelf te delen." : account.subscribed ? "Je hebt toegang tot volledige artikelen." : "Je account is actief. Kies een abonnement voor volledige toegang.";
  document.querySelector("#profileForm input").value = account.user.email;
  document.querySelector("#subscriptionText").textContent = account.subscribed ? `Actief ${account.subscription?.plan || "abonnement"} · geldig tot ${account.subscription?.current_period_end ? new Date(account.subscription.current_period_end).toLocaleDateString("nl-NL") : "onbekend"}` : "Geen actief abonnement.";
  document.querySelector("#shareForm").classList.toggle("hidden", !account.ownSubscribed);
  const shareList = document.querySelector("#shareList");
  shareList.classList.toggle("hidden", !account.ownSubscribed);
  shareList.innerHTML = account.ownSubscribed ? `<h3>Gedeelde toegang</h3>${(account.shares || []).length ? account.shares.map((share) => `<div class="api-key-row"><span>${escapeHTML(share.email)} · ${escapeHTML(share.status)}</span>${["pending", "accepted"].includes(share.status) ? `<button type="button" data-share-id="${escapeHTML(share.id)}">Toegang intrekken</button>` : ""}</div>`).join("") : "<p>Nog geen gedeelde gebruikers.</p>"}` : "";
  shareList.querySelectorAll("[data-share-id]").forEach((button) => button.addEventListener("click", async () => {
    const response = await fetch(`/api/account/shares/${button.dataset.shareId}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) return showToast(payload.error);
    await renderAccount();
    showToast("Toegang ingetrokken");
  }));
  const keys = account.subscribed ? await (await fetch("/api/account/api-keys")).json() : { keys: [] };
  document.querySelector("#apiKeyList").innerHTML = (keys.keys || []).map((key) => `<div class="api-key-row"><span>${escapeHTML(key.name)}</span><code>${escapeHTML(key.key_prefix)}…</code><button data-api-key-id="${key.id}" type="button">×</button></div>`).join("");
  document.querySelectorAll("[data-api-key-id]").forEach((button) => button.addEventListener("click", async () => { await fetch(`/api/account/api-keys/${button.dataset.apiKeyId}`, { method: "DELETE" }); renderAccount(); }));
}
document.querySelector("#accountButton").addEventListener("click", async () => { accountOverlay.classList.remove("hidden"); await refreshAuth(); await renderAccount(); });
document.querySelector("#closeAccount").addEventListener("click", () => accountOverlay.classList.add("hidden"));
document.querySelector("#loginMemberForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email.value, password: form.password.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); await refreshAuth(); await renderAccount(); await loadArticles(); showToast("Inloggen geslaagd"); });
document.querySelector("#signupForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const response = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email.value, password: form.password.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); document.querySelector("#authNotice").textContent = `Controleer ${form.email.value}. Je account wordt actief na bevestiging van de verificatielink.`; document.querySelector("#resendVerification").classList.remove("hidden"); showToast("Verificatiemail verstuurd"); });
document.querySelector("#resendVerification").addEventListener("click", async () => { const form = document.querySelector("#signupForm"); const response = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); showToast("Verificatiemail opnieuw verstuurd"); });
document.querySelector("#profileForm").addEventListener("submit", async (event) => { event.preventDefault(); const response = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: event.currentTarget.email.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); await refreshAuth(); showToast(payload.verificationRequired ? "Nieuw verificatiebericht verstuurd" : "Accountgegevens opgeslagen"); });
document.querySelector("#subscribeButton").addEventListener("click", async () => { const response = await fetch("/api/billing/checkout", { method: "POST" }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); window.location.href = payload.url; });
document.querySelector("#shareForm").addEventListener("submit", async (event) => { event.preventDefault(); const response = await fetch("/api/account/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: event.currentTarget.email.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); event.currentTarget.reset(); await renderAccount(); showToast("Uitnodiging verstuurd"); });
document.querySelector("#apiKeyForm").addEventListener("submit", async (event) => { event.preventDefault(); const response = await fetch("/api/account/api-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: event.currentTarget.name.value }) }); const payload = await response.json(); if (!response.ok) return showToast(payload.error); event.currentTarget.reset(); window.prompt("Bewaar deze API-key. Hij wordt niet opnieuw volledig getoond.", payload.key); await renderAccount(); });
document.querySelector("#logoutButton").addEventListener("click", async () => { await fetch("/api/auth/logout", { method: "POST" }); currentUser = null; accountOverlay.classList.add("hidden"); document.querySelector("#accountButton").textContent = "SA"; await loadArticles(); });

renderNews();
refreshAuth();
loadArticles();
loadStats();
const verificationToken = new URLSearchParams(window.location.search).get("verify");
if (verificationToken) {
  fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: verificationToken }) })
    .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error); await refreshAuth(); await renderAccount(); await loadArticles(); accountOverlay.classList.remove("hidden"); showToast(payload.subscribed ? "E-mailadres bevestigd; gedeeld abonnement geactiveerd." : "E-mailadres bevestigd."); })
    .catch((error) => showToast(error.message))
    .finally(() => { window.history.replaceState({}, document.title, window.location.pathname); });
}
