// Padhai Buddy quiz generation. Runs on Vercel as a serverless function.
// The API key lives only in the ANTHROPIC_API_KEY environment variable, never in the page.
// Without a key it answers "not_configured" and the page plays its sample quiz.

const STYLES = {
  neet: "NEET (UG) style: one-correct MCQs; include at least one assertion-reason and one match-the-column question",
  jee: "JEE Main style: conceptual and application MCQs; include a numerical question if the notes contain numbers",
  upsc: "UPSC Prelims style: mostly statement-based questions ('Consider the following statements… Which of the statements given above is/are correct?') with options like '1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'",
  cbse: "CBSE board exam style: competency-based MCQs plus assertion-reason questions",
  mcq: "plain multiple-choice questions for quick revision",
};
const LANGS = {
  en: "English",
  hi: "Hindi in Devanagari script, using the terms Hindi-medium textbooks use (keep standard symbols like CO2, ATP)",
  hn: "Hinglish: Hindi written in Roman script mixed with English technical terms, friendly tutor tone",
};
const AR_OPTS = [
  "Both A and R are true, and R is the correct explanation of A",
  "Both A and R are true, but R is not the correct explanation of A",
  "A is true, but R is false",
  "A is false, but R is true",
];

// Best-effort rate limit: 8 quizzes per IP per 10 minutes (per warm instance).
const WINDOW_MS = 10 * 60 * 1000, MAX_REQ = 8;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_REQ) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

function prompt(notes, style, lang, n) {
  return `You write exam practice questions for an Indian student strictly from the student's own notes.

Exam style: ${STYLES[style]}.
Language of questions, options and explanations: ${LANGS[lang]}.
Number of questions: exactly ${n}.

Rules:
- Every question and its correct answer must be supported by the notes. Use no outside facts.
- Each question has exactly 4 options and exactly one correct answer. Wrong options must be plausible.
- "source": copy ONE sentence from the notes word for word (in the notes' own language) that proves the answer.
- "explain": one short sentence on why the answer is right.
- type is one of "mcq", "assertion_reason", "match", "statement", "numerical".
- For assertion_reason, put "Assertion (A): ...\\nReason (R): ..." in "q" and use these 4 options in this order: ${JSON.stringify(AR_OPTS)} (translated if needed).
- For match, put both columns in "q" on separate lines like "(a) X   (i) Y", and make each option a code like "a-iii, b-ii, c-i, d-iv".
- Vary which option letter is correct.

Reply with only JSON in this shape:
{"topic":"2-4 word topic name","questions":[{"type":"mcq","q":"...","options":["...","...","...","..."],"answer":0,"source":"...","explain":"..."}]}

Notes:
"""
${notes}
"""`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ code: "invalid_request" }); }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ code: "not_configured" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ code: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
  const style = STYLES[body?.style] ? body.style : "mcq";
  const lang = LANGS[body?.lang] ? body.lang : "en";
  const n = Math.min(15, Math.max(3, parseInt(body?.n, 10) || 6));
  if (notes.split(/\s+/).length < 25) return res.status(400).json({ code: "invalid_request" });
  if (notes.length > 20000) return res.status(413).json({ code: "prompt_too_large" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.QUIZ_MODEL || "claude-haiku-5-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt(notes, style, lang, n) }],
      }),
    });
    if (r.status === 429) return res.status(429).json({ code: "rate_limited" });
    if (!r.ok) return res.status(502).json({ code: "upstream_error" });
    const data = await r.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ code: "invalid_json" });
    let quiz;
    try { quiz = JSON.parse(m[0]); } catch { return res.status(502).json({ code: "invalid_json" }); }
    return res.status(200).json(quiz);
  } catch {
    return res.status(502).json({ code: "upstream_error" });
  }
};
