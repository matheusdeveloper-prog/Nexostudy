const MODEL = "gemini-3.8-flash";
const GROQ_MODEL = "openai/gpt-oss-20b";
async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}
async function callGroq(apiKey, systemText, messages) {
  const chatMessages = [
    { role: "system", content: systemText },
    ...messages.slice(-14)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))
  ];
  const upstream = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: chatMessages, temperature: 0.65, max_tokens: 1600 })
  }, 20000);
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(`Groq HTTP ${upstream.status}: ${data?.error?.message || ""}`);
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Groq retornou resposta vazia.");
  return answer;
}
const DEFAULT_SYSTEM_PROMPT = `Você é BRENO, o tutor inteligente de estudos do NEXO.

IDENTIDADE E TOM:
- Fale sempre em português brasileiro, de modo acolhedor, claro, natural e respeitoso.
- Seja um tutor paciente e encorajador; evite respostas robóticas ou excessivamente longas.
- Ajuste a explicação ao nível de conhecimento demonstrado pelo estudante.

COMO ENSINAR:
- Se a pergunta for sobre um conceito, explique a ideia central, depois dê um exemplo simples.
- Em problemas, organize a resolução por etapas e explique o motivo de cada etapa.
- Se o estudante pedir resposta direta, responda primeiro e depois ofereça uma explicação breve.
- Se houver ambiguidade, faça uma pergunta objetiva em vez de adivinhar.
- Em exercícios, não entregue tudo de uma vez se o estudante estiver tentando aprender; dê pistas quando isso for útil.
- Corrija erros com gentileza, explicando o que precisa ser ajustado, sem julgamento.
- Ajude com resumos, revisão, flashcards, perguntas de treino, planos de estudo e interpretação de textos.
- Não invente dados, fontes, citações ou resultados. Indique quando estiver incerto.
- Não alegue que viu arquivos, imagens ou páginas que não foram enviados ou disponibilizados na conversa.

SOBRE O NEXO:
- Você é o assistente de aprendizagem do NEXO. Se o estudante perguntar sobre funcionalidades específicas do NEXO que você não conhece, seja transparente e não invente.`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "A chave GEMINI_API_KEY não está configurada na Vercel." });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: "Formato de conversa inválido." });
    }

    const messages = body.messages.slice(-14);
    const suppliedSystem = messages
      .filter((m) => m && m.role === "system" && typeof m.content === "string")
      .map((m) => m.content.trim())
      .filter(Boolean)
      .join("\n\n");

    // O prompt base do BRENO é sempre aplicado, mesmo se a página não enviar system.
    const systemText = [DEFAULT_SYSTEM_PROMPT, suppliedSystem].filter(Boolean).join("\n\n");

    const contents = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content.slice(0, 12000) }]
      }));

    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return res.status(400).json({ error: "Envie uma mensagem para o BRENO." });
    }

    let upstream;
    let result = {};
    let answer = "";
    let primaryFailed = false;
    let primaryErrorMessage = "";
    try {
      upstream = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            generationConfig: { temperature: 0.65, maxOutputTokens: 1600 }
          })
        },
        25000
      );
      result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        primaryFailed = upstream.status === 429 || upstream.status >= 500;
        primaryErrorMessage = result?.error?.message || `Gemini HTTP ${upstream.status}`;
        if (!primaryFailed) {
          const safeMessage = upstream.status === 400
            ? "O Gemini não aceitou a mensagem. Tente reformular sua pergunta."
            : upstream.status === 403 || upstream.status === 401
              ? "A autenticação do Gemini falhou. Confira a variável GEMINI_API_KEY na Vercel."
              : "Não consegui completar essa solicitação. Tente novamente.";
          return res.status(502).json({ error: safeMessage });
        }
      } else {
        const candidate = result?.candidates?.[0];
        answer = (candidate?.content?.parts || []).map((part) => part.text || "").join("").trim();
        if (answer) return res.status(200).json({ message: { content: answer, provider: "gemini" } });
        primaryFailed = true;
        primaryErrorMessage = "Gemini returned no text.";
      }
    } catch (primaryError) {
      primaryFailed = true; // timeout, falha de rede ou erro transitório no fetch
      primaryErrorMessage = primaryError?.message || "Gemini timeout/network error";
    }

    if (primaryFailed && process.env.GROQ_API_KEY) {
      try {
        const fallbackAnswer = await callGroq(process.env.GROQ_API_KEY, systemText, messages);
        console.warn("BRENO used Groq fallback after Gemini error:", primaryErrorMessage);
        return res.status(200).json({ message: { content: fallbackAnswer, provider: "groq-fallback" } });
      } catch (fallbackError) {
        console.error("Groq fallback failed:", fallbackError?.message || "erro desconhecido");
      }
    }
    if (primaryFailed) {
      console.error("Gemini primary failed:", primaryErrorMessage);
      return res.status(503).json({
        error: process.env.GROQ_API_KEY
          ? "Gemini e a IA de reserva estão indisponíveis agora. Tente novamente em instantes."
          : "O Gemini está instável e a IA de reserva ainda não está configurada. Configure GROQ_API_KEY na Vercel para ativar a reserva automática."
      });
    }


  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({ error: "O BRENO demorou para responder. Tente novamente." });
    }
    console.error("BRENO API error:", error?.message || "erro desconhecido");
    return res.status(500).json({ error: "Não foi possível conectar ao BRENO agora. Tente novamente." });
  }
}
