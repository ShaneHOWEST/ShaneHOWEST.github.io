const aiProvider = {
  async generateArticle({ topic, tone }) {
    if (!topic || topic.trim().length < 3) {
      throw new Error("Vul minimaal drie tekens in.");
    }
    const response = await fetch("/api/admin/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, tone }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Artikel genereren mislukt.");
    return payload.article;
  },
};
