// ── CONFIG ─────────────────────────────────────────────────────────────────
const GROQ_MODEL   = "llama-3.3-70b-versatile";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const BREVO_URL    = "https://api.brevo.com/v3/smtp/email";
const NOTIF_EMAIL  = "yaoakoe.ovb@gmail.com";
const MAX_STR_LEN  = 200;

// ── HELPERS ─────────────────────────────────────────────────────────────────
function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(payload),
  };
}

function escapeHtml(input = "") {
  return String(input)
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#39;");
}

function sanitize(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_STR_LEN).replace(/[\x00-\x1F\x7F]/g, "");
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

// ── VALIDATION ──────────────────────────────────────────────────────────────
const ALLOWED = {
  education:   ["Inférieur au CESS", "CESS", "Bachelier ou plus"],
  status:      ["Je cherche d'abord la sécurité", "Je suis motivé(e) par la commission"],
  resilience:  ["Je me décourage vite", "Je fais une pause et j'analyse", "Je continue avec constance"],
  coldCalling: ["Aucune expérience", "Un peu, sans affinité particulière", "Très à l'aise"],
  ambition:    ["Cherche surtout la stabilité", "Vise une forte performance commerciale", "Évoluer vers un rôle d'encadrement"],
};

function validateBody(body) {
  const required = ["firstName","lastName","birthDate","city","gsm","email","education","status","resilience","ambition","coldCalling"];
  for (const key of required) {
    if (!body[key] || sanitize(body[key]) === "") return `Champ manquant ou vide : ${key}`;
  }
  // Email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return "Format email invalide.";
  // GSM format
  if (!/^[\d\s\+\-\(\)]{7,20}$/.test(body.gsm)) return "Format GSM invalide.";
  // Date sanity
  const d = new Date(body.birthDate);
  if (Number.isNaN(d.getTime())) return "Date de naissance invalide.";
  const age = ageFromBirthDate(body.birthDate);
  if (age === null || age < 16 || age > 75) return "Date de naissance hors plage acceptable.";
  // Enum checks
  for (const [key, values] of Object.entries(ALLOWED)) {
    if (!values.includes(body[key])) return `Valeur non autorisée pour le champ : ${key}`;
  }
  return null;
}

// ── PROMPT ──────────────────────────────────────────────────────────────────
function buildPrompt(data) {
  return `
Tu es un recruteur expert pour des délégués commerciaux indépendants en assurances, payés 100 % à la commission (secteur FSMA, Belgique).

CONTEXTE MÉTIER :
- Le rôle exige : prospection active (cold calling), résilience face au refus, autonomie totale, goût du défi commercial.
- Il n'existe pas de filet de sécurité salarial. La motivation intrinsèque et la tolérance à l'échec sont déterminantes.
- Un candidat qui cherche avant tout la sécurité est structurellement inadapté à ce modèle.

DONNÉES CANDIDAT :
${JSON.stringify(data, null, 2)}

RÈGLES DE CLASSIFICATION (non négociables) :
1. "Inférieur au CESS" → catégorie forcée : Éliminé, score ≤ 20.
2. "Je cherche d'abord la sécurité" → signal disqualifiant fort ; score ≤ 45, catégorie Éliminé ou Fragile selon le reste.
3. Résilience "Je me décourage vite" → pénalité forte sur le score.
4. Cold calling "Aucune expérience" seul n'élimine pas, mais pèse négativement s'il est combiné à une faible résilience.
5. "Très à l'aise" + "Je continue avec constance" + ambition de croissance → signal fort Top Performer.

CATÉGORIES :
- Éliminé : profil structurellement inadapté, ne pas rappeler.
- Fragile : potentiel mais signaux de risque majeurs ; entretien de qualification court avant décision.
- Junior/Développeur : motivé, manque d'expérience ou de confiance ; accompagnement intensif requis.
- Top Performer/Chasseur : profil aligné avec les exigences du poste ; à prioriser.

RETOURNE UNIQUEMENT un objet JSON valide, sans markdown, sans prose, sans preamble :
{
  "category":            "Éliminé|Fragile|Junior/Développeur|Top Performer/Chasseur",
  "score":               0-100,
  "verdict":             "une phrase directe et professionnelle",
  "strengths":           ["point fort 1", "point fort 2"],
  "risks":               ["risque 1", "risque 2"],
  "interview_questions": ["question 1", "question 2", "question 3"],
  "summary":             "résumé bref (2-3 phrases) en français, ton recruteur expert"
}
`.trim();
}

// ── GROQ CALL ────────────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch(GROQ_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      temperature: 0.15,
      max_tokens:  800,
      messages: [
        { role: "system", content: "Tu es un moteur d'analyse de candidature RH. Réponds UNIQUEMENT avec du JSON valide, aucun autre texte." },
        { role: "user",   content: prompt },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Groq API error ${res.status}`);

  const raw = data.choices?.[0]?.message?.content || "";
  const cleaned = raw.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i,     "")
    .replace(/\s*```$/i,     "");

  return JSON.parse(cleaned);
}

// ── EMAIL ────────────────────────────────────────────────────────────────────
function buildEmailHtml(body, analysis, ageText) {
  const fullName = `${escapeHtml(body.firstName)} ${escapeHtml(body.lastName)}`;
  const categoryColor = {
    "Éliminé":                 "#ef4444",
    "Fragile":                 "#f59e0b",
    "Junior/Développeur":      "#3b82f6",
    "Top Performer/Chasseur":  "#22c55e",
  }[analysis.category] || "#6b7280";

  const li = arr => (arr || []).map(x => `<li style="margin-bottom:4px">${escapeHtml(x)}</li>`).join("");

  return `
<div style="font-family:Arial,sans-serif;line-height:1.65;color:#111827;max-width:640px;margin:0 auto">
  <div style="background:#07080c;padding:24px 28px;border-radius:12px 12px 0 0">
    <h2 style="margin:0;color:#e8eef8;font-size:1.3rem">Nouvelle candidature reçue</h2>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px 28px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 6px"><strong>Candidat :</strong> ${fullName}</p>
    <p style="margin:0 0 6px"><strong>Ville :</strong> ${escapeHtml(body.city)}</p>
    <p style="margin:0 0 6px"><strong>GSM :</strong> ${escapeHtml(body.gsm)}</p>
    <p style="margin:0 0 6px"><strong>Email :</strong> ${escapeHtml(body.email)}</p>
    <p style="margin:0 0 16px"><strong>Âge :</strong> ${escapeHtml(ageText)}</p>

    <div style="background:${categoryColor}18;border:1px solid ${categoryColor}44;border-radius:8px;padding:16px;margin-bottom:20px">
      <p style="margin:0 0 4px"><strong>Catégorie :</strong> <span style="color:${categoryColor};font-weight:700">${escapeHtml(analysis.category || "")}</span></p>
      <p style="margin:0 0 4px"><strong>Score :</strong> ${escapeHtml(String(analysis.score ?? ""))}/100</p>
      <p style="margin:0"><strong>Verdict :</strong> ${escapeHtml(analysis.verdict || "")}</p>
    </div>

    <p style="margin:0 0 10px"><strong>Résumé :</strong><br>${escapeHtml(analysis.summary || "")}</p>

    <p style="margin:12px 0 6px"><strong>Forces :</strong></p>
    <ul style="margin:0 0 12px;padding-left:20px">${li(analysis.strengths)}</ul>

    <p style="margin:0 0 6px"><strong>Risques :</strong></p>
    <ul style="margin:0 0 12px;padding-left:20px">${li(analysis.risks)}</ul>

    <p style="margin:0 0 6px"><strong>Questions d'entretien suggérées :</strong></p>
    <ol style="margin:0 0 20px;padding-left:20px">${li(analysis.interview_questions)}</ol>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
    <p style="margin:0 0 4px;color:#6b7280;font-size:.9rem"><strong>Réponses brutes :</strong></p>
    <ul style="color:#6b7280;font-size:.9rem;padding-left:20px;margin:6px 0 0">
      <li>Diplôme : ${escapeHtml(body.education)}</li>
      <li>Motivation : ${escapeHtml(body.status)}</li>
      <li>Résilience : ${escapeHtml(body.resilience)}</li>
      <li>Ambition : ${escapeHtml(body.ambition)}</li>
      <li>Cold calling : ${escapeHtml(body.coldCalling)}</li>
    </ul>
  </div>
</div>`.trim();
}

function buildEmailText(body, analysis, ageText) {
  const fullName = `${body.firstName} ${body.lastName}`;
  return [
    "=== Nouvelle candidature ===",
    `Candidat      : ${fullName}`,
    `Ville         : ${body.city}`,
    `GSM           : ${body.gsm}`,
    `Email         : ${body.email}`,
    `Âge           : ${ageText}`,
    "",
    `Catégorie     : ${analysis.category || ""}`,
    `Score         : ${analysis.score ?? ""}/100`,
    `Verdict       : ${analysis.verdict || ""}`,
    `Résumé        : ${analysis.summary || ""}`,
    "",
    `Forces        : ${(analysis.strengths        || []).join(" | ")}`,
    `Risques       : ${(analysis.risks            || []).join(" | ")}`,
    `Questions     : ${(analysis.interview_questions || []).join(" | ")}`,
    "",
    "--- Réponses brutes ---",
    `Diplôme       : ${body.education}`,
    `Motivation    : ${body.status}`,
    `Résilience    : ${body.resilience}`,
    `Ambition      : ${body.ambition}`,
    `Cold calling  : ${body.coldCalling}`,
  ].join("\n");
}

async function sendBrevoEmail({ apiKey, subject, htmlContent, textContent }) {
  const res = await fetch(BREVO_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key":      apiKey,
    },
    body: JSON.stringify({
      sender:      { name: "Candidatures BYA-X", email: NOTIF_EMAIL },
      to:          [{ email: NOTIF_EMAIL, name: "Boris BYA-X" }],
      subject,
      htmlContent,
      textContent,
    }),
  });

  const data = await res.json().catch(() => ({}));
  console.log("[Brevo] Status:", res.status, "| Response:", JSON.stringify(data));

  if (!res.ok) {
    throw new Error(data.message || `Brevo error ${res.status}`);
  }
  return data;
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Method guard
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  // Env guard
  const groqApiKey  = process.env.GROQ_API_KEY;
  const brevoApiKey = process.env.BREVO_API_KEY;
  if (!groqApiKey || !brevoApiKey) return json(500, { error: "Configuration serveur incomplète." });

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Corps de requête JSON invalide." });
  }

  // Sanitize strings
  const clean = {};
  for (const key of Object.keys(body)) {
    clean[key] = sanitize(body[key]);
  }

  // Validate
  const validationError = validateBody(clean);
  if (validationError) return json(400, { error: validationError });

  // Compute age
  const age    = ageFromBirthDate(clean.birthDate);
  const ageText = age === null ? "Inconnue" : `${age} ans`;
  const candidateData = { ...clean, age: ageText };

  try {
    // 1. AI analysis
    const analysis = await callGroq(groqApiKey, buildPrompt(candidateData));

    // 2. Email notification
    const fullName = `${clean.firstName} ${clean.lastName}`;
    const subject  = `Candidature analysée · ${fullName} · ${analysis.category || "N/A"}`;
    await sendBrevoEmail({
      apiKey:      brevoApiKey,
      subject,
      htmlContent: buildEmailHtml(clean, analysis, ageText),
      textContent: buildEmailText(clean, analysis, ageText),
    });

    return json(200, {
      ok:       true,
      category: analysis.category,
      score:    analysis.score,
    });

  } catch (err) {
    console.error("[process.js] Error:", err.message);
    return json(500, { error: "Erreur de traitement de la candidature. Merci de réessayer." });
  }
};
